"""EC2 (query protocol): instances, volumes, regions, reservations, instance types."""

from __future__ import annotations

import base64
import fnmatch
import json

from ..state import RegionInfo, Session, Volume, World, iso
from ..wire import (
    XMLNS_EC2,
    Request,
    Response,
    credential_region,
    error_ec2,
    flatten_members,
    flatten_structs,
    query_action,
    tag,
    xml_response,
)

# Only the shapes the tasks need; enough to bin-pack against.
INSTANCE_TYPES: dict[str, dict[str, float]] = {
    "t3.small": {"vcpu": 2, "memory_gib": 2.0, "max_pods": 11},
    "t3.medium": {"vcpu": 2, "memory_gib": 4.0, "max_pods": 17},
    "t3.large": {"vcpu": 2, "memory_gib": 8.0, "max_pods": 35},
    "t3.xlarge": {"vcpu": 4, "memory_gib": 16.0, "max_pods": 58},
    "m5.large": {"vcpu": 2, "memory_gib": 8.0, "max_pods": 29},
    "m5.xlarge": {"vcpu": 4, "memory_gib": 16.0, "max_pods": 58},
    "m5.2xlarge": {"vcpu": 8, "memory_gib": 32.0, "max_pods": 58},
    "m6i.large": {"vcpu": 2, "memory_gib": 8.0, "max_pods": 29},
    "m6i.xlarge": {"vcpu": 4, "memory_gib": 16.0, "max_pods": 58},
    "m6i.2xlarge": {"vcpu": 8, "memory_gib": 32.0, "max_pods": 58},
    "m6i.4xlarge": {"vcpu": 16, "memory_gib": 64.0, "max_pods": 234},
    "c6i.large": {"vcpu": 2, "memory_gib": 4.0, "max_pods": 29},
    "c6i.xlarge": {"vcpu": 4, "memory_gib": 8.0, "max_pods": 58},
    "c6i.2xlarge": {"vcpu": 8, "memory_gib": 16.0, "max_pods": 58},
    "c6i.4xlarge": {"vcpu": 16, "memory_gib": 32.0, "max_pods": 234},
    "r6i.large": {"vcpu": 2, "memory_gib": 16.0, "max_pods": 29},
    "r6i.xlarge": {"vcpu": 4, "memory_gib": 32.0, "max_pods": 58},
    "r6i.2xlarge": {"vcpu": 8, "memory_gib": 64.0, "max_pods": 58},
    "r6i.4xlarge": {"vcpu": 16, "memory_gib": 128.0, "max_pods": 234},
}


def _envelope(action: str, inner: str) -> Response:
    body = (
        f'<{action}Response xmlns="{XMLNS_EC2}">'
        "<requestId>mockaws-ec2</requestId>"
        f"{inner}"
        f"</{action}Response>"
    )
    return xml_response(body)


def _filters(form: dict[str, str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    index = 1
    while True:
        name = form.get(f"Filter.{index}.Name")
        if name is None:
            break
        values = flatten_members(form, f"Filter.{index}.Value")
        out[name] = values
        index += 1
    return out


def _instance_matches(instance, filters: dict[str, list[str]]) -> bool:
    for name, values in filters.items():
        if name == "instance-state-name":
            if instance.state not in values:
                return False
        elif name == "instance-type":
            if instance.instance_type not in values:
                return False
        elif name.startswith("tag:"):
            key = name[4:]
            if instance.tags.get(key) not in values:
                return False
        elif name == "availability-zone":
            if instance.availability_zone not in values:
                return False
    return True


def _value_matches(candidate: str | None, patterns: list[str]) -> bool:
    """EC2 filter values are OR'd and may carry `*` and `?` wildcards."""
    if candidate is None:
        return False
    text = str(candidate)
    return any(fnmatch.fnmatchcase(text, pattern) for pattern in patterns)


# Every filter DescribeVolumes documents that this world can answer. Anything
# outside the set is rejected the way EC2 rejects it, rather than quietly
# widening the caller's result.
_VOLUME_FILTERS = frozenset(
    {
        "attachment.attach-time",
        "attachment.delete-on-termination",
        "attachment.device",
        "attachment.instance-id",
        "attachment.status",
        "availability-zone",
        "create-time",
        "encrypted",
        "multi-attach-enabled",
        "size",
        "snapshot-id",
        "status",
        "tag-key",
        "tag-value",
        "volume-id",
        "volume-type",
    }
)


def _volume_matches(volume: Volume, name: str, values: list[str]) -> bool:
    if name.startswith("tag:"):
        return _value_matches(volume.tags.get(name[4:]), values)
    if name == "tag-key":
        return any(_value_matches(key, values) for key in volume.tags)
    if name == "tag-value":
        return any(_value_matches(value, values) for value in volume.tags.values())
    if name == "volume-id":
        return _value_matches(volume.volume_id, values)
    if name == "volume-type":
        return _value_matches(volume.volume_type, values)
    if name == "status":
        return _value_matches(volume.state, values)
    if name == "size":
        return _value_matches(volume.size, values)
    if name == "availability-zone":
        return _value_matches(volume.availability_zone, values)
    if name == "snapshot-id":
        return _value_matches(volume.snapshot_id, values)
    if name == "encrypted":
        return _value_matches("true" if volume.encrypted else "false", values)
    if name == "multi-attach-enabled":
        return _value_matches("true" if volume.multi_attach_enabled else "false", values)
    if name == "create-time":
        return _value_matches(iso(volume.create_time), values)
    if name == "attachment.instance-id":
        return any(_value_matches(att.instance_id, values) for att in volume.attachments)
    if name == "attachment.status":
        return any(_value_matches(att.state, values) for att in volume.attachments)
    if name == "attachment.device":
        return any(_value_matches(att.device, values) for att in volume.attachments)
    if name == "attachment.attach-time":
        return any(_value_matches(iso(att.attach_time), values) for att in volume.attachments)
    if name == "attachment.delete-on-termination":
        return any(
            _value_matches("true" if att.delete_on_termination else "false", values)
            for att in volume.attachments
        )
    return False


# Every filter DescribeReservedInstances documents that this world can answer.
_RESERVATION_FILTERS = frozenset(
    {
        "availability-zone",
        "duration",
        "end",
        "instance-type",
        "product-description",
        "reserved-instances-id",
        "scope",
        "start",
        "state",
        "tag-key",
        "tag-value",
    }
)


def _reservation_matches(reservation, name: str, values: list[str]) -> bool:
    if name.startswith("tag:"):
        return _value_matches(reservation.tags.get(name[4:]), values)
    if name == "tag-key":
        return any(_value_matches(key, values) for key in reservation.tags)
    if name == "tag-value":
        return any(_value_matches(value, values) for value in reservation.tags.values())
    if name == "reserved-instances-id":
        return _value_matches(reservation.reserved_instances_id, values)
    if name == "instance-type":
        return _value_matches(reservation.instance_type, values)
    if name == "availability-zone":
        return _value_matches(reservation.availability_zone, values)
    if name == "product-description":
        return _value_matches(reservation.product_description, values)
    if name == "scope":
        return _value_matches(reservation.scope, values)
    if name == "state":
        return _value_matches(reservation.state, values)
    if name == "duration":
        return _value_matches(reservation.duration, values)
    if name == "start":
        return _value_matches(iso(reservation.start), values)
    if name == "end":
        return _value_matches(iso(reservation.end), values)
    return False


def _encode_token(region: str, offset: int) -> str:
    raw = json.dumps({"r": region, "o": offset}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_token(token: str, region: str) -> int | None:
    """Offset carried by a pagination token, or None if it is not ours.

    Tokens are regional: EC2 hands them out per endpoint, and replaying one
    against a different region is a client error, not an empty page.
    """
    try:
        padded = token + "=" * (-len(token) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        if payload.get("r") != region:
            return None
        return int(payload["o"])
    except Exception:  # noqa: BLE001 - any malformed token is just invalid
        return None


def _region_info(account, region: str) -> RegionInfo | None:
    for info in account.regions:
        if info.name == region:
            return info
    return None


def _subnet_matches(subnet, filters: dict[str, list[str]]) -> bool:
    for name, values in filters.items():
        if name == "subnet-id":
            if subnet.subnet_id not in values:
                return False
        elif name == "availability-zone":
            if subnet.availability_zone not in values:
                return False
        elif name == "vpc-id":
            if subnet.vpc_id not in values:
                return False
        elif name == "state":
            if subnet.state not in values:
                return False
        elif name.startswith("tag:"):
            key = name[4:]
            if subnet.tags.get(key) not in values:
                return False
    return True


def handle(world: World, req: Request, injector, caller: Session | None) -> Response:
    if caller is None:
        return error_ec2("AuthFailure", "AWS was not able to validate the provided access credentials", 403)
    account = world.account(caller.account_id)
    if account is None:
        return error_ec2("AuthFailure", "Unknown account", 403)

    action = query_action(req)
    form = req.form()
    # One endpoint serves every region, so the signature scope is the only
    # statement of which regional endpoint the caller believes it reached.
    region = credential_region(req.headers) or world.region

    if action == "DescribeRegions":
        known = account.regions or [RegionInfo(name=world.region)]
        all_regions = form.get("AllRegions", "false").lower() == "true"
        wanted = set(flatten_members(form, "RegionName"))
        filters = _filters(form)

        entries = []
        for info in known:
            if not all_regions and info.opt_in_status == "not-opted-in":
                continue
            if wanted and info.name not in wanted:
                continue
            if "region-name" in filters and not _value_matches(info.name, filters["region-name"]):
                continue
            if "opt-in-status" in filters and not _value_matches(
                info.opt_in_status, filters["opt-in-status"]
            ):
                continue
            if "endpoint" in filters and not _value_matches(
                info.resolved_endpoint, filters["endpoint"]
            ):
                continue
            entries.append(
                "<item>"
                f"{tag('regionName', info.name)}"
                f"{tag('regionEndpoint', info.resolved_endpoint)}"
                f"{tag('optInStatus', info.opt_in_status)}"
                "</item>"
            )
        return _envelope("DescribeRegions", f"<regionInfo>{''.join(entries)}</regionInfo>")

    if action == "DescribeVolumes":
        info = _region_info(account, region)
        if info is not None and info.error_code:
            return error_ec2(info.error_code, info.error_message, info.error_status)

        filters = _filters(form)
        unknown = [
            name for name in filters if not name.startswith("tag:") and name not in _VOLUME_FILTERS
        ]
        if unknown:
            return error_ec2(
                "InvalidParameterValue",
                f"The filter '{unknown[0]}' is invalid",
                400,
            )

        wanted = set(flatten_members(form, "VolumeId"))
        matching = [
            volume
            for volume in sorted(account.volumes, key=lambda v: v.volume_id)
            if volume.region == region
            and (not wanted or volume.volume_id in wanted)
            and all(_volume_matches(volume, name, values) for name, values in filters.items())
        ]

        token = form.get("NextToken", "")
        if token:
            offset = _decode_token(token, region)
            if offset is None:
                return error_ec2("InvalidParameterValue", "Invalid value for NextToken", 400)
        else:
            offset = 0
            # DescribeVolumes is documented as being able to answer with no
            # volumes and a token, with the results arriving on a later page.
            if info is not None and info.empty_first_page and matching:
                return _envelope(
                    "DescribeVolumes",
                    f"<volumeSet></volumeSet>{tag('nextToken', _encode_token(region, 0))}",
                )

        requested = int(form.get("MaxResults", "500"))
        page_size = injector.page_size("ec2", "DescribeVolumes", requested)
        if info is not None and info.page_size > 0:
            page_size = min(page_size, info.page_size)
        page_size = max(1, page_size)

        page = matching[offset : offset + page_size]
        truncated = offset + page_size < len(matching)

        entries = []
        for volume in page:
            tags = "".join(
                f"<item>{tag('key', k)}{tag('value', v)}</item>" for k, v in sorted(volume.tags.items())
            )
            attachments = "".join(
                "<item>"
                f"{tag('volumeId', volume.volume_id)}"
                f"{tag('instanceId', att.instance_id)}"
                f"{tag('device', att.device)}"
                f"{tag('status', att.state)}"
                f"{tag('attachTime', iso(att.attach_time))}"
                f"{tag('deleteOnTermination', 'true' if att.delete_on_termination else 'false')}"
                "</item>"
                for att in volume.attachments
            )
            optional = ""
            if volume.iops is not None:
                optional += tag("iops", int(volume.iops))
            if volume.throughput is not None:
                optional += tag("throughput", int(volume.throughput))
            if volume.snapshot_id:
                optional += tag("snapshotId", volume.snapshot_id)
            entries.append(
                "<item>"
                f"{tag('volumeId', volume.volume_id)}"
                f"{tag('size', volume.size)}"
                f"{tag('availabilityZone', volume.availability_zone)}"
                f"{tag('status', volume.state)}"
                f"{tag('createTime', iso(volume.create_time))}"
                f"{tag('volumeType', volume.volume_type)}"
                f"{tag('encrypted', 'true' if volume.encrypted else 'false')}"
                f"{tag('multiAttachEnabled', 'true' if volume.multi_attach_enabled else 'false')}"
                f"{optional}"
                f"<attachmentSet>{attachments}</attachmentSet>"
                f"<tagSet>{tags}</tagSet>"
                "</item>"
            )
        next_token = (
            tag("nextToken", _encode_token(region, offset + page_size)) if truncated else ""
        )
        return _envelope("DescribeVolumes", f"<volumeSet>{''.join(entries)}</volumeSet>{next_token}")

    if action == "DescribeInstances":
        filters = _filters(form)
        wanted = set(flatten_members(form, "InstanceId"))
        requested = int(form.get("MaxResults", "1000"))
        page_size = injector.page_size("ec2", "DescribeInstances", requested)
        token = form.get("NextToken", "")

        matching = [
            instance
            for instance in sorted(account.instances.values(), key=lambda i: i.instance_id)
            if instance.region == region
            and (not wanted or instance.instance_id in wanted)
            and _instance_matches(instance, filters)
        ]
        start = 0
        if token:
            start = next((i for i, inst in enumerate(matching) if inst.instance_id > token), len(matching))
        page = matching[start : start + page_size]
        truncated = start + page_size < len(matching)

        reservations = []
        for instance in page:
            tags = "".join(
                f"<item>{tag('key', k)}{tag('value', v)}</item>" for k, v in sorted(instance.tags.items())
            )
            lifecycle = tag("instanceLifecycle", "spot") if instance.lifecycle == "spot" else ""
            reservations.append(
                "<item>"
                f"{tag('reservationId', 'r-' + instance.instance_id[2:])}"
                f"{tag('ownerId', account.account_id)}"
                "<instancesSet><item>"
                f"{tag('instanceId', instance.instance_id)}"
                f"{tag('instanceType', instance.instance_type)}"
                f"{tag('launchTime', iso(instance.launch_time))}"
                f"<instanceState>{tag('name', instance.state)}</instanceState>"
                f"<placement>{tag('availabilityZone', instance.availability_zone)}</placement>"
                f"{tag('privateIpAddress', instance.private_ip)}"
                f"{tag('privateDnsName', 'ip-' + instance.private_ip.replace('.', '-') + '.ec2.internal')}"
                f"{tag('platformDetails', instance.platform_details)}"
                f"<cpuOptions>{tag('coreCount', int(INSTANCE_TYPES.get(instance.instance_type, {}).get('vcpu', 2)))}"
                f"{tag('threadsPerCore', 2)}</cpuOptions>"
                f"{lifecycle}"
                f"<tagSet>{tags}</tagSet>"
                "</item></instancesSet>"
                "</item>"
            )
        next_token = tag("nextToken", page[-1].instance_id) if truncated and page else ""
        return _envelope("DescribeInstances", f"<reservationSet>{''.join(reservations)}</reservationSet>{next_token}")

    if action == "DescribeSubnets":
        wanted = set(flatten_members(form, "SubnetId"))
        filters = _filters(form)
        requested = int(form.get("MaxResults", "1000"))
        page_size = injector.page_size("ec2", "DescribeSubnets", requested)
        token = form.get("NextToken", "")

        matching = [
            subnet
            for subnet in sorted(account.subnets.values(), key=lambda s: s.subnet_id)
            if (not wanted or subnet.subnet_id in wanted) and _subnet_matches(subnet, filters)
        ]
        start = 0
        if token:
            start = next(
                (i for i, sub in enumerate(matching) if sub.subnet_id > token), len(matching)
            )
        page = matching[start : start + page_size]
        truncated = start + page_size < len(matching)

        entries = []
        for subnet in page:
            tags = "".join(
                f"<item>{tag('key', k)}{tag('value', v)}</item>" for k, v in sorted(subnet.tags.items())
            )
            entries.append(
                "<item>"
                f"{tag('subnetId', subnet.subnet_id)}"
                f"{tag('availabilityZone', subnet.availability_zone)}"
                f"{tag('availabilityZoneId', subnet.availability_zone_id)}"
                f"{tag('vpcId', subnet.vpc_id)}"
                f"{tag('cidrBlock', subnet.cidr_block)}"
                f"{tag('availableIpAddressCount', subnet.available_ip_address_count)}"
                f"{tag('state', subnet.state)}"
                f"{tag('ownerId', account.account_id)}"
                f"<tagSet>{tags}</tagSet>"
                "</item>"
            )
        next_token = tag("nextToken", page[-1].subnet_id) if truncated and page else ""
        return _envelope("DescribeSubnets", f"<subnetSet>{''.join(entries)}</subnetSet>{next_token}")

    if action == "DescribeReservedInstances":
        info = _region_info(account, region)
        if info is not None and info.error_code:
            return error_ec2(info.error_code, info.error_message, info.error_status)

        filters = _filters(form)
        unknown = [
            name for name in filters if not name.startswith("tag:") and name not in _RESERVATION_FILTERS
        ]
        if unknown:
            return error_ec2("InvalidParameterValue", f"The filter '{unknown[0]}' is invalid", 400)

        wanted = set(flatten_members(form, "ReservedInstancesId"))
        # DescribeReservedInstances is one of the EC2 calls that carries no
        # token: the regional endpoint answers with everything it holds, and the
        # only way to see another region's reservations is to ask that region.
        matching = [
            ri
            for ri in sorted(account.reserved_instances, key=lambda r: r.reserved_instances_id)
            if ri.region == region
            and (not wanted or ri.reserved_instances_id in wanted)
            and all(_reservation_matches(ri, name, values) for name, values in filters.items())
        ]

        entries = []
        for ri in matching:
            tags = "".join(
                f"<item>{tag('key', k)}{tag('value', v)}</item>" for k, v in sorted(ri.tags.items())
            )
            recurring = (
                "<recurringCharges><item>"
                f"{tag('frequency', 'Hourly')}{tag('amount', ri.recurring_hourly)}"
                "</item></recurringCharges>"
                if ri.recurring_hourly
                else "<recurringCharges></recurringCharges>"
            )
            entries.append(
                "<item>"
                f"{tag('reservedInstancesId', ri.reserved_instances_id)}"
                f"{tag('instanceType', ri.instance_type)}"
                f"{tag('availabilityZone', ri.availability_zone)}"
                f"{tag('instanceCount', ri.instance_count)}"
                f"{tag('productDescription', ri.product_description)}"
                f"{tag('start', iso(ri.start))}{tag('end', iso(ri.end))}"
                f"{tag('duration', ri.duration)}"
                f"{tag('offeringClass', ri.offering_class)}{tag('offeringType', ri.offering_type)}"
                f"{tag('instanceTenancy', ri.instance_tenancy)}{tag('scope', ri.scope)}"
                f"{tag('currencyCode', ri.currency_code)}"
                f"{tag('fixedPrice', ri.fixed_price)}{tag('usagePrice', ri.usage_price)}"
                f"{recurring}"
                f"{tag('state', ri.state)}"
                f"<tagSet>{tags}</tagSet>"
                "</item>"
            )
        return _envelope(
            "DescribeReservedInstances",
            f"<reservedInstancesSet>{''.join(entries)}</reservedInstancesSet>",
        )

    if action == "DescribeInstanceTypes":
        wanted = set(flatten_members(form, "InstanceType")) or set(INSTANCE_TYPES)
        entries = []
        for name in sorted(wanted):
            spec = INSTANCE_TYPES.get(name)
            if spec is None:
                continue
            entries.append(
                "<item>"
                f"{tag('instanceType', name)}"
                f"<vCpuInfo>{tag('defaultVCpus', int(spec['vcpu']))}</vCpuInfo>"
                f"<memoryInfo>{tag('sizeInMiB', int(spec['memory_gib'] * 1024))}</memoryInfo>"
                "</item>"
            )
        return _envelope("DescribeInstanceTypes", f"<instanceTypeSet>{''.join(entries)}</instanceTypeSet>")

    if action == "CreateTags":
        resources = flatten_members(form, "ResourceId")
        pairs = flatten_structs(form, "Tag")
        for resource_id in resources:
            instance = account.instances.get(resource_id)
            if instance is None:
                continue
            for pair in pairs:
                if "Key" in pair:
                    instance.tags[pair["Key"]] = pair.get("Value", "")
        return _envelope("CreateTags", "<return>true</return>")

    return error_ec2("InvalidAction", f"Unsupported EC2 action: {action}", 400)
