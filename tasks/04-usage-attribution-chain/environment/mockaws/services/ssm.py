"""SSM (json-1.1): the public global-infrastructure tree plus account parameters.

Two trees answer here. `/aws/service/global-infrastructure/...` is public AWS
metadata and is served from a table rather than from the scenario. Everything
else comes from the calling account's own parameter tree, which a scenario
declares as a flat name-to-value map.
"""

from __future__ import annotations

from ..state import Session, World
from ..wire import Request, Response, error_json, json_response, json_target

REGION_LONG_NAMES = {
    "us-east-1": "US East (N. Virginia)",
    "us-east-2": "US East (Ohio)",
    "us-west-1": "US West (N. California)",
    "us-west-2": "US West (Oregon)",
    "eu-west-1": "Europe (Ireland)",
    "eu-central-1": "Europe (Frankfurt)",
    "ap-south-1": "Asia Pacific (Mumbai)",
    "ap-southeast-1": "Asia Pacific (Singapore)",
    "ap-southeast-2": "Asia Pacific (Sydney)",
    "ap-northeast-1": "Asia Pacific (Tokyo)",
    "ca-central-1": "Canada (Central)",
    "sa-east-1": "South America (Sao Paulo)",
}

PREFIX = "/aws/service/global-infrastructure/regions/"
SUFFIX = "/longName"
DEFAULT_MAX_RESULTS = 10


def _lookup(world: World, caller: Session, name: str) -> str | None:
    if name.startswith(PREFIX) and name.endswith(SUFFIX):
        return REGION_LONG_NAMES.get(name[len(PREFIX) : -len(SUFFIX)])
    account = world.account(caller.account_id)
    if account is None:
        return None
    return account.parameters.get(name)


def _parameter(world: World, name: str, value: str) -> dict[str, object]:
    return {
        "Name": name,
        "Type": "String",
        "Value": value,
        "Version": 1,
        "ARN": f"arn:aws:ssm:{world.region}::parameter{name}",
        "DataType": "text",
    }


def handle(world: World, req: Request, injector, caller: Session | None) -> Response:
    if caller is None:
        return error_json("UnrecognizedClientException", "The security token is invalid", 403)

    action = json_target(req)
    payload = req.json()

    if action == "GetParameter":
        name = payload.get("Name", "")
        value = _lookup(world, caller, name)
        if value is None:
            return error_json("ParameterNotFound", f"Parameter {name} not found", 400)
        return json_response({"Parameter": _parameter(world, name, value)})

    if action == "GetParameters":
        found, missing = [], []
        for name in payload.get("Names", []) or []:
            value = _lookup(world, caller, name)
            if value is None:
                missing.append(name)
            else:
                found.append(_parameter(world, name, value))
        return json_response({"Parameters": found, "InvalidParameters": missing})

    if action == "GetParametersByPath":
        path = payload.get("Path", "")
        recursive = bool(payload.get("Recursive", False))
        account = world.account(caller.account_id)
        names = sorted(account.parameters) if account is not None else []
        selected = []
        for name in names:
            if not name.startswith(path):
                continue
            remainder = name[len(path) :].lstrip("/")
            if not recursive and "/" in remainder:
                continue
            selected.append(name)

        token = payload.get("NextToken", "")
        start = 0
        if token:
            start = next((index for index, name in enumerate(selected) if name > token), len(selected))
        requested = int(payload.get("MaxResults", DEFAULT_MAX_RESULTS) or DEFAULT_MAX_RESULTS)
        page_size = max(1, injector.page_size("ssm", "GetParametersByPath", min(requested, DEFAULT_MAX_RESULTS)))
        page = selected[start : start + page_size]
        body: dict[str, object] = {
            "Parameters": [_parameter(world, name, account.parameters[name]) for name in page]
        }
        if start + page_size < len(selected) and page:
            body["NextToken"] = page[-1]
        return json_response(body)

    return error_json(
        "InvalidAction",
        "Only GetParameter, GetParameters and GetParametersByPath are supported",
        400,
    )
