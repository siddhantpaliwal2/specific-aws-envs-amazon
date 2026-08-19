"""Small Harbor adapter extensions used by the recorded cohort.

Harbor 0.18.0 installs mini-SWE-agent without boto3, while LiteLLM's Bedrock
route imports it lazily. The stock installer therefore
fails before the first Opus request. The task also exposes a local AWS-compatible
endpoint, so Bedrock provider credentials must not replace the task's emulator
credentials. This subclass installs boto3, gives LiteLLM a named provider
profile, removes the provider variables before the model-controlled shell can
run, and verifies the emulator through the repository's normal AWS SDK path.
"""

from harbor.agents.installed.mini_swe_agent import MiniSweAgent
from harbor.environments.base import BaseEnvironment


class BedrockMiniSweAgent(MiniSweAgent):
    """Keep Bedrock authentication separate from task-local AWS authentication."""

    _PROFILE_NAME = "bedrock-provider"
    _PROFILE_DIR = "/tmp/mswea-bedrock-provider"
    _CREDENTIALS_FILE = f"{_PROFILE_DIR}/credentials"
    _CONFIG_FILE = f"{_PROFILE_DIR}/config"
    _PROVIDER_ENV_KEYS = (
        "BEDROCK_PROVIDER_AWS_ACCESS_KEY_ID",
        "BEDROCK_PROVIDER_AWS_SECRET_ACCESS_KEY",
        "BEDROCK_PROVIDER_AWS_SESSION_TOKEN",
        "BEDROCK_PROVIDER_AWS_REGION",
    )

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        # Harbor otherwise insists on forwarding AWS_ACCESS_KEY_ID as the model
        # API key. A harmless sentinel bypasses that forwarding; LiteLLM uses the
        # explicit named profile in mini-swe-bedrock.yaml instead.
        self._extra_env.setdefault("MSWEA_API_KEY", "bedrock-profile-auth")
        self._extra_env.setdefault(
            "AWS_SHARED_CREDENTIALS_FILE", self._CREDENTIALS_FILE
        )
        self._extra_env.setdefault("AWS_CONFIG_FILE", self._CONFIG_FILE)

    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
        version_spec = f"=={self._version}" if self._version else ""
        await self.exec_as_agent(
            environment,
            command=(
                'if [ -f "$HOME/.local/bin/env" ]; then '
                '. "$HOME/.local/bin/env"; '
                'else export PATH="$HOME/.local/bin:$PATH"; fi; '
                "uv tool install --force --with fastapi --with orjson --with boto3 "
                f"mini-swe-agent{version_spec} && mini-swe-agent --help"
            ),
        )

        required = self._PROVIDER_ENV_KEYS[:2]
        missing = [key for key in required if not self._get_env(key)]
        if missing:
            raise RuntimeError(
                "Missing Bedrock provider credential variables: " + ", ".join(missing)
            )

        # The command contains variable names only. Credential values arrive
        # through Harbor's setup-only scoped environment and are not written to
        # command logs or the mini-SWE trajectory.
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; umask 077; "
                f"mkdir -p {self._PROFILE_DIR}; "
                "python3 - <<'PY'\n"
                "import os\n"
                "from pathlib import Path\n"
                f"root = Path({self._PROFILE_DIR!r})\n"
                "access = os.environ['BEDROCK_PROVIDER_AWS_ACCESS_KEY_ID']\n"
                "secret = os.environ['BEDROCK_PROVIDER_AWS_SECRET_ACCESS_KEY']\n"
                "token = os.environ.get('BEDROCK_PROVIDER_AWS_SESSION_TOKEN', '')\n"
                "region = os.environ.get('BEDROCK_PROVIDER_AWS_REGION', 'us-east-1')\n"
                f"lines = ['[{self._PROFILE_NAME}]', f'aws_access_key_id = {{access}}', f'aws_secret_access_key = {{secret}}']\n"
                "if token:\n"
                "    lines.append(f'aws_session_token = {token}')\n"
                "(root / 'credentials').write_text('\\n'.join(lines) + '\\n')\n"
                f"(root / 'config').write_text('[profile {self._PROFILE_NAME}]\\nregion = ' + region + '\\n')\n"
                "(root / 'credentials').chmod(0o600)\n"
                "(root / 'config').chmod(0o600)\n"
                "PY"
            ),
        )

    async def setup(self, environment: BaseEnvironment) -> None:
        try:
            await super().setup(environment)
        finally:
            # Trial creates a fresh scoped environment for run(). Removing these
            # now means model-generated commands inherit only the task image's
            # AWS_ENDPOINT_URL and emulator credentials.
            for key in self._PROVIDER_ENV_KEYS:
                self._extra_env.pop(key, None)

    async def run(self, instruction, environment, context) -> None:
        # Fail the trial before the first model request unless the exact agent
        # shell can authenticate to the local emulator through the same AWS SDK
        # resolution path used by the repository.
        await self.exec_as_agent(
            environment,
            cwd="/app",
            command=(
                "set -euo pipefail; "
                "case ${AWS_ENDPOINT_URL:-} in "
                "http://127.0.0.1:*|http://localhost:*) ;; "
                "*) echo 'emulator preflight: non-local AWS endpoint' >&2; exit 1 ;; "
                "esac; "
                "case ${AWS_ACCESS_KEY_ID:-} in "
                "AKIAMETERING*) ;; "
                "*) echo 'emulator preflight: task credential missing' >&2; exit 1 ;; "
                "esac; "
                "node - <<'NODE'\n"
                "const { S3Client, ListBucketsCommand } = require('@aws-sdk/client-s3');\n"
                "new S3Client({}).send(new ListBucketsCommand({}))\n"
                "  .then(() => process.stdout.write('emulator preflight: ok\\n'))\n"
                "  .catch((error) => {\n"
                "    console.error('emulator preflight:', error.name || error.Code || error.message);\n"
                "    process.exit(1);\n"
                "  });\n"
                "NODE"
            ),
        )
        await super().run(instruction, environment, context)
