"""Pricing API (json-1.1): GetProducts / DescribeServices / GetAttributeValues.

The catalogue is served in the order the scenario declares it, because that is
the only ordering the real service guarantees either: a caller that wants one
particular rate has to narrow on product attributes rather than trust position.
"""

from __future__ import annotations

import json

from ..state import Session, World
from ..wire import Request, Response, error_json, json_response, json_target


def _attribute_names(world: World, service_code: str) -> list[str]:
    names: set[str] = set()
    for item in world.pricing:
        if service_code and item.service_code != service_code:
            continue
        names.update(item.attributes.keys())
    return sorted(names)


def handle(world: World, req: Request, injector, caller: Session | None) -> Response:
    if caller is None:
        return error_json("UnrecognizedClientException", "The security token is invalid", 403)

    target = json_target(req)
    payload = req.json()

    if target == "DescribeServices":
        wanted = payload.get("ServiceCode", "")
        codes = sorted({item.service_code for item in world.pricing})
        if wanted:
            if wanted not in codes:
                return error_json("NotFoundException", f"No service with code {wanted}", 404)
            codes = [wanted]
        return json_response(
            {
                "Services": [
                    {"ServiceCode": code, "AttributeNames": _attribute_names(world, code)} for code in codes
                ],
                "FormatVersion": "aws_v1",
            }
        )

    if target == "GetAttributeValues":
        service_code = payload.get("ServiceCode", "")
        attribute = payload.get("AttributeName", "")
        if not attribute:
            return error_json("InvalidParameterException", "AttributeName is required", 400)
        values = sorted(
            {
                item.attributes[attribute]
                for item in world.pricing
                if (not service_code or item.service_code == service_code) and attribute in item.attributes
            }
        )
        return json_response({"AttributeValues": [{"Value": value} for value in values]})

    if target != "GetProducts":
        return error_json("InvalidParameterException", f"Unsupported Pricing action: {target}", 400)

    service_code = payload.get("ServiceCode", "")
    filters = payload.get("Filters", [])

    def matches(item) -> bool:
        if service_code and item.service_code != service_code:
            return False
        for spec in filters:
            field = spec.get("Field", "")
            value = spec.get("Value", "")
            # `ServiceCode` is a filter field in its own right rather than a
            # product attribute, and it is spelled differently in the two
            # places, so both spellings resolve to the same thing.
            if field in ("ServiceCode", "servicecode"):
                if item.service_code != value:
                    return False
                continue
            if item.attributes.get(field) != value:
                return False
        return True

    selected = [item for item in world.pricing if matches(item)]
    max_results = int(payload.get("MaxResults", 100))
    page_size = injector.page_size("pricing", "GetProducts", max_results)
    token = payload.get("NextToken")
    offset = int(token) if token else 0
    page = selected[offset : offset + page_size]

    price_list = [
        json.dumps(
            {
                "product": {
                    "sku": item.sku,
                    "productFamily": item.attributes.get("productFamily", "Compute Instance"),
                    "attributes": item.attributes,
                },
                "serviceCode": item.service_code,
                "terms": item.terms,
                "version": "20260101000000",
                "publicationDate": "2026-01-01T00:00:00Z",
            },
            separators=(",", ":"),
        )
        for item in page
    ]
    response = {"FormatVersion": "aws_v1", "PriceList": price_list}
    if offset + page_size < len(selected):
        response["NextToken"] = str(offset + page_size)
    return json_response(response)
