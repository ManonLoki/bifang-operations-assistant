#!/usr/bin/env python3
"""Validate a resumable Bifang public-services profile without network access."""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any
from urllib.parse import SplitResult, urlsplit


SCHEMA_PATH = (
    Path(__file__).resolve().parent.parent
    / "references"
    / "public-services-profile.schema.json"
)
MAX_PROFILE_BYTES = 1_048_576
APP_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$")
TRACK_PATH_PATTERN = re.compile(
    r"^/apps/([a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?)/v1/track$"
)
APPLICATION_VERSION_API_PATH = "/tools/version-control/v1"
APPROVED_APPLICATION_VERSION_BASE_URLS = frozenset(
    ("https://gateway.kaiwhale.com/tools/version-control/v1",)
)

SENSITIVE_KEY_MARKERS = (
    "secretid",
    "secretkey",
    "token",
    "cookie",
    "authorization",
    "credential",
    "password",
    "privatekey",
    "accesskey",
    "appkey",
    "appsecret",
    "xappkey",
    "xappsecret",
    "sessionkey",
    "useraccount",
    "accountid",
    "hardwareid",
    "hwid",
    "machineid",
    "deviceid",
    "数据库凭据",
    "用户账号",
    "硬件标识",
    "硬件id",
    "密钥",
    "令牌",
)
SENSITIVE_ASSIGNMENT_PATTERN = re.compile(
    r"(?i)(?:\b(?:secretid|secretkey|token|cookie|authorization|password|"
    r"private[ _-]?key|access[ _-]?key|"
    r"(?:x[ _-]?)?app[ _-]?(?:key|secret))\b|"
    r"(?:密钥|令牌|数据库凭据|用户账号|硬件(?:标识|id)))"
    r"\s*[:：=]\s*\S{4,}"
)
AUTHORIZATION_VALUE_PATTERN = re.compile(
    r"(?i)\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"
)

PROFILE_COMPLETION_FIELDS = (
    "display_name",
    "app_id",
    "owner",
    "platforms",
    "architectures",
    "framework",
    "current_version",
    "version_source",
    "app_config_strategy",
    "startup_entry",
    "main_window_ready_hook",
    "external_link_handler",
    "exit_handler",
    "cloudbase_env_id",
    "cloudbase_origin",
    "telemetry_endpoint",
    "infrastructure_version",
    "infrastructure_source_commit",
    "registration_status",
    "legacy_track_status",
    "deployment_gates",
    "privacy_notice",
    "current_stage",
)
PROFILE_V2_COMPLETION_FIELDS = (
    "update_transport",
    "application_version_contract_version",
    "application_version_base_url",
    "release_streams",
    "version_api_auth_status",
    "legacy_update_status",
)
STAGE_PREREQUISITE_GATES = {
    2: (
        "profile_complete",
        "app_id_confirmed",
        "uses_existing_free_environment",
        "free_environment_confirmed",
    ),
    3: (
        "app_registered",
        "app_display_name_registered",
        "platform_code_mapping_confirmed",
    ),
    4: (
        "cloudbase_config_reviewed",
        "version_api_config_reviewed",
        "function_deployed",
        "collection_created",
        "collection_admin_only",
        "route_deployed",
        "online_e2e_passed",
        "version_api_service_verified",
        "runtime_auth_ready",
        "dashboard_display_name_verified",
    ),
    5: (
        "client_integration_complete",
        "telemetry_app_version_verified",
        "version_api_client_integrated",
        "legacy_client_update_removed",
    ),
    6: (
        "telemetry_app_version_online_verified",
        "dashboard_display_name_verified",
        "online_e2e_passed",
        "version_api_service_verified",
        "runtime_auth_ready",
        "client_integration_complete",
        "version_api_client_integrated",
        "client_e2e_passed",
        "version_api_client_e2e_passed",
    ),
    7: (
        "telemetry_app_version_online_verified",
        "dashboard_display_name_verified",
        "client_e2e_passed",
        "version_api_client_e2e_passed",
        "privacy_notice_ready",
    ),
    8: (
        "migration_observation_complete",
        "legacy_usage_assessed",
        "owner_approved",
        "legacy_client_update_removed",
        "legacy_cloud_resources_removed",
    ),
}

LEGACY_V1_MIGRATION_ERROR = (
    "$.profile_schema_version: legacy profile schema v1 is obsolete; explicitly "
    "migrate it to profile_schema_version 2 before application-version API v1 "
    "onboarding (the validator did not modify the file)"
)


class DuplicateKeyError(ValueError):
    """Raised when a JSON object contains an ambiguous duplicate key."""


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def read_json_file(path: Path, *, max_bytes: int = MAX_PROFILE_BYTES) -> Any:
    """Read bounded UTF-8 JSON while rejecting duplicate object keys."""

    raw = path.read_bytes()
    if len(raw) > max_bytes:
        raise ValueError(f"file exceeds {max_bytes} bytes")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError("file must be UTF-8 JSON") from error
    try:
        return json.loads(text, object_pairs_hook=_reject_duplicate_keys)
    except json.JSONDecodeError as error:
        raise ValueError(
            f"invalid JSON at line {error.lineno}, column {error.colno}"
        ) from error


def load_schema(path: Path = SCHEMA_PATH) -> dict[str, Any]:
    schema = read_json_file(path)
    if not isinstance(schema, dict):
        raise ValueError("profile schema must contain an object")
    return schema


def validate_profile(
    profile: Any,
    schema: dict[str, Any] | None = None,
    *,
    project_root: Path | None = None,
    require_update_center: bool = False,
) -> list[str]:
    """Return deterministic validation errors; an empty list means valid."""

    if isinstance(profile, dict) and profile.get("profile_schema_version") == 1:
        return [LEGACY_V1_MIGRATION_ERROR]

    active_schema = schema if schema is not None else load_schema()
    errors: list[str] = []
    _validate_schema_value(profile, active_schema, active_schema, "$", errors)
    _scan_sensitive_content(profile, "$", errors)
    if isinstance(profile, dict):
        if require_update_center and profile.get("update_transport") != "client-update-center-v1":
            errors.append("$.update_transport: migrate to client-update-center-v1 before onboarding")
        if profile.get("update_transport") == "client-update-center-v1":
            _validate_update_center_semantics(profile, errors, project_root)
        else:
            for field in ("update_center_base_url", "update_center_auth_status", "update_targets", "offline_enforcement"):
                if field in profile:
                    errors.append(f"$.{field}: requires client-update-center-v1 transport")
            _validate_profile_semantics(profile, errors, project_root)
    return sorted(set(errors))


def _validate_update_center_semantics(profile: dict[str, Any], errors: list[str], project_root: Path | None) -> None:
    """Check new update-center profiles without treating old release streams as active."""
    for field in ("application_version_base_url", "application_version_contract_version", "release_streams", "version_api_auth_binding_id", "version_api_auth_status"):
        if field in profile:
            errors.append(f"$.{field}: legacy application-version field must be removed after migration")
    if "display_name" in profile:
        try:
            validate_display_name(profile["display_name"])
        except ValueError as error:
            errors.append(f"$.display_name: {error}")
    app_id = profile.get("app_id")
    if isinstance(app_id, str) and not re.fullmatch(r"[a-z][a-z0-9-]{1,48}[a-z0-9]", app_id):
        errors.append("$.app_id: joint onboarding requires 3-50 lowercase letters, digits or hyphens, starting with a letter and ending with a letter or digit")
    parsed = {}
    for field in ("cloudbase_origin", "telemetry_endpoint"):
        value = profile.get(field)
        if isinstance(value, str):
            url = _validate_https_url(value, f"$.{field}", errors)
            if url:
                parsed[field] = url
                if not (url.hostname or "").endswith(".app.tcloudbase.com"):
                    errors.append(f"$.{field}: must use the confirmed CloudBase default gateway")
    origin = parsed.get("cloudbase_origin")
    telemetry = parsed.get("telemetry_endpoint")
    if origin and origin.path not in ("", "/"):
        errors.append("$.cloudbase_origin: must not contain a path")
    if telemetry:
        match = TRACK_PATH_PATTERN.fullmatch(telemetry.path)
        if not match or match.group(1) != app_id:
            errors.append("$.telemetry_endpoint: path must match the app_id")
        if origin and _url_origin(telemetry) != _url_origin(origin):
            errors.append("$.telemetry_endpoint: origin does not match cloudbase_origin")
    targets = profile.get("update_targets")
    if isinstance(targets, list):
        seen = set()
        for index, target in enumerate(targets):
            if not isinstance(target, dict):
                continue
            key = tuple(target.get(k) for k in ("os", "architecture", "installation_type", "channel"))
            if not all(isinstance(value, str) for value in key):
                continue
            if key in seen:
                errors.append(f"$.update_targets[{index}]: duplicate target")
            seen.add(key)
            host_platform = "linux" if target.get("os") in ("ubuntu", "debian") else target.get("os")
            # Mirror updateTarget.allOf: the small schema walker handles only
            # structural rules; cross-field target constraints are checked here.
            if target.get("architecture") == "x86" and target.get("os") != "windows":
                errors.append(f"$.update_targets[{index}].architecture: x86 is supported only on windows")
            host_arch = {"x86_64": "x64", "x86": "ia32"}.get(target.get("architecture"), target.get("architecture"))
            if isinstance(profile.get("platforms"), list) and host_platform not in profile["platforms"]:
                errors.append(f"$.update_targets[{index}].os: platform is not declared")
            if isinstance(profile.get("architectures"), list) and host_arch not in profile["architectures"]:
                errors.append(f"$.update_targets[{index}].architecture: architecture is not declared")
    gates = profile.get("deployment_gates") if isinstance(profile.get("deployment_gates"), dict) else {}
    stage = profile.get("current_stage")
    if profile.get("update_center_base_url") in ("http://127.0.0.1:8080", "http://127.0.0.1:8080/"):
        for gate in ("update_center_service_verified", "update_center_client_e2e_passed"):
            if gates.get(gate) is True:
                errors.append(f"$.deployment_gates.{gate}: loopback tests cannot certify production update-center verification")
        if stage in (6, 7):
            errors.append("$.current_stage: loopback update-center configuration cannot complete production client E2E or release")
    for gate in ("version_api_config_reviewed", "version_api_service_verified", "version_api_client_integrated", "version_api_client_e2e_passed", "platform_code_mapping_confirmed"):
        if gates.get(gate) is True:
            errors.append(f"$.deployment_gates.{gate}: legacy application-version evidence cannot certify update-center onboarding")
    registration_status = profile.get("registration_status")
    if registration_status in ("registered", "verified") and gates.get("app_registered") is False:
        errors.append("$.deployment_gates.app_registered: conflicts with registration_status")
    if registration_status == "not_registered" and gates.get("app_registered") is True:
        errors.append("$.deployment_gates.app_registered: conflicts with registration_status")
    if gates.get("profile_complete") is True or (isinstance(stage, int) and not isinstance(stage, bool) and stage >= 2):
        for field in (*PROFILE_COMPLETION_FIELDS, "update_transport", "update_center_base_url", "update_center_auth_status", "update_targets", "offline_enforcement", "legacy_update_status"):
            if field not in profile:
                errors.append(f"$.{field}: required for a complete update-center profile")
        if "product_purpose" not in profile and "product_key" not in profile:
            errors.append("$.product_purpose: product_purpose or product_key is required")
        if isinstance(targets, list):
            actual_targets = [t for t in targets if isinstance(t, dict) and isinstance(t.get("os"), str) and isinstance(t.get("architecture"), str)]
            mapped_platforms = {"linux" if t.get("os") in ("ubuntu", "debian") else t.get("os") for t in actual_targets}
            mapped_architectures = {{"x86_64": "x64", "x86": "ia32"}.get(t.get("architecture"), t.get("architecture")) for t in actual_targets}
            for platform in profile.get("platforms", []) if isinstance(profile.get("platforms"), list) else []:
                if platform not in mapped_platforms:
                    errors.append(f"$.update_targets: no confirmed target for platform {platform!r}")
            for architecture in profile.get("architectures", []) if isinstance(profile.get("architectures"), list) else []:
                if architecture not in mapped_architectures:
                    errors.append(f"$.update_targets: no confirmed target for architecture {architecture!r}")
    _validate_legacy_update_removal(profile, gates, errors)
    dependencies = {
        "telemetry_app_version_verified": ("profile_complete",),
        "telemetry_app_version_online_verified": ("telemetry_app_version_verified", "function_deployed", "route_deployed"),
        "app_display_name_registered": ("profile_complete", "app_id_confirmed"),
        "dashboard_display_name_verified": ("app_registered", "app_display_name_registered", "cloudbase_config_reviewed"),
        "cloudbase_config_reviewed": ("app_registered",),
        "function_deployed": ("cloudbase_config_reviewed",),
        "collection_created": ("cloudbase_config_reviewed",),
        "collection_admin_only": ("collection_created",),
        "route_deployed": ("function_deployed",),
        "online_e2e_passed": ("function_deployed", "route_deployed"),
        "client_e2e_passed": ("client_integration_complete",),
    }
    for gate, required in dependencies.items():
        if gates.get(gate) is True:
            for dependency in required:
                if gates.get(dependency) is not True:
                    errors.append(f"$.deployment_gates.{gate}: requires {dependency}=true")
    requirements = {
        2: ("profile_complete", "app_id_confirmed", "uses_existing_free_environment", "free_environment_confirmed"),
        3: ("app_registered", "app_display_name_registered"),
        4: ("cloudbase_config_reviewed", "function_deployed", "route_deployed", "online_e2e_passed", "dashboard_display_name_verified"),
        5: ("client_integration_complete", "telemetry_app_version_verified", "update_center_client_integrated", "legacy_client_update_removed"),
        6: ("client_integration_complete", "update_center_client_integrated", "update_center_service_verified", "runtime_auth_ready", "client_e2e_passed", "update_center_client_e2e_passed", "telemetry_app_version_online_verified"),
        7: ("client_e2e_passed", "update_center_client_e2e_passed", "privacy_notice_ready"),
        8: ("migration_observation_complete", "legacy_usage_assessed", "owner_approved", "legacy_client_update_removed", "legacy_cloud_resources_removed"),
    }
    if isinstance(stage, int) and not isinstance(stage, bool):
        for gate in requirements.get(stage, ()):
            if gates.get(gate) is not True:
                errors.append(f"$.deployment_gates.{gate}: must be true before stage {stage}")
        if stage in (3, 4, 6, 7, 8) and registration_status not in ("registered", "verified"):
            errors.append("$.registration_status: must be registered or verified for this stage")
    if gates.get("update_center_client_e2e_passed") is True and (gates.get("update_center_client_integrated") is not True or gates.get("update_center_service_verified") is not True):
        errors.append("$.deployment_gates.update_center_client_e2e_passed: requires integrated client and verified service")
    if gates.get("runtime_auth_ready") is True and profile.get("update_center_auth_status") != "verified":
        errors.append("$.update_center_auth_status: must be verified when runtime_auth_ready is true")
    if gates.get("update_center_service_verified") is True and gates.get("runtime_auth_ready") is not True:
        errors.append("$.deployment_gates.update_center_service_verified: requires runtime_auth_ready=true")
    if gates.get("client_integration_complete") is True and (gates.get("telemetry_app_version_verified") is not True or gates.get("update_center_client_integrated") is not True):
        errors.append("$.deployment_gates.client_integration_complete: requires telemetry verification and update-center integration")
    distribution = profile.get("sdk_distribution")
    if isinstance(distribution, dict):
        for field in ("source", "verification_evidence"):
            value = distribution.get(field)
            if isinstance(value, str) and not _is_safe_relative_sdk_source(value):
                errors.append(f"$.sdk_distribution.{field}: must be a safe project-relative path or fixed package spec")
        if distribution.get("kind") == "private_package":
            for field in ("verification_evidence", "immutable_reference"):
                if field not in distribution:
                    errors.append(f"$.sdk_distribution.{field}: required for private_package")
            if isinstance(distribution.get("version"), str) and distribution.get("source") != f"@bifang/telemetry-update-sdk@{distribution['version']}":
                errors.append("$.sdk_distribution.source: private package must use the exact immutable package spec")
    framework = profile.get("framework")
    if stage in (5, 6, 7) and isinstance(framework, str) and re.search(r"(?i)(?:^|[^a-z0-9])(?:node(?:\.?js)?|electron(?:\.?js)?|nw(?:\.?js)?)(?:$|[^a-z0-9])", framework):
        if gates.get("sdk_distribution_ready") is not True:
            errors.append("$.deployment_gates.sdk_distribution_ready: must be true before Node/Electron stage 5")
        if not isinstance(profile.get("sdk_distribution"), dict) or not isinstance(profile.get("sdk_artifact_sha256"), str):
            errors.append("$.sdk_distribution: verified distribution and artifact SHA-256 are required")
        elif project_root is None:
            errors.append("$.deployment_gates.sdk_distribution_ready: offline verification requires the target project root")
        else:
            try:
                from verify_sdk_distribution import SDKDistributionVerificationError, verify_sdk_distribution
                verify_sdk_distribution(profile, project_root)
            except (SDKDistributionVerificationError, OSError, ValueError) as error:
                errors.append(f"$.deployment_gates.sdk_distribution_ready: offline SDK distribution verification failed: {error}")


def validate_display_name(value: Any) -> None:
    """Require a confirmed Chinese product name suitable for dashboard labels."""

    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 100
        or value != value.strip()
        or any(
            unicodedata.category(c) in {"Cc", "Cf", "Cs"} or c in "<>"
            for c in value
        )
        or not any(
            c == "〇"
            or unicodedata.name(c, "").startswith(
                ("CJK UNIFIED IDEOGRAPH-", "CJK COMPATIBILITY IDEOGRAPH-")
            )
            for c in value
        )
    ):
        raise ValueError(
            "display_name must be confirmed Chinese text of 1-100 Unicode characters, "
            "without surrounding whitespace, control/format characters, or markup"
        )


def _validate_schema_value(
    value: Any,
    rule: dict[str, Any],
    root_schema: dict[str, Any],
    path: str,
    errors: list[str],
) -> None:
    if "$ref" in rule:
        reference = rule["$ref"]
        prefix = "#/$defs/"
        if not isinstance(reference, str) or not reference.startswith(prefix):
            errors.append(f"{path}: unsupported schema reference")
            return
        name = reference[len(prefix) :]
        target = root_schema.get("$defs", {}).get(name)
        if not isinstance(target, dict):
            errors.append(f"{path}: unresolved schema reference {reference}")
            return
        _validate_schema_value(value, target, root_schema, path, errors)
        return

    if "const" in rule and value != rule["const"]:
        errors.append(f"{path}: must equal {rule['const']!r}")
        return
    if "enum" in rule and value not in rule["enum"]:
        choices = ", ".join(repr(item) for item in rule["enum"])
        errors.append(f"{path}: must be one of {choices}")
        return

    expected_type = rule.get("type")
    if expected_type is not None and not _matches_json_type(value, expected_type):
        errors.append(f"{path}: must be {expected_type}")
        return

    if isinstance(value, dict):
        properties = rule.get("properties", {})
        required = rule.get("required", [])
        for name in required:
            if name not in value:
                errors.append(f"{path}.{name}: required field is missing")
        if rule.get("additionalProperties") is False:
            for name in sorted(set(value) - set(properties)):
                errors.append(f"{path}.{name}: unknown field is not allowed")
        for name in sorted(set(value) & set(properties)):
            _validate_schema_value(
                value[name],
                properties[name],
                root_schema,
                f"{path}.{name}",
                errors,
            )
        return

    if isinstance(value, list):
        if len(value) < rule.get("minItems", 0):
            errors.append(
                f"{path}: must contain at least {rule['minItems']} item(s)"
            )
        if "maxItems" in rule and len(value) > rule["maxItems"]:
            errors.append(
                f"{path}: must contain at most {rule['maxItems']} item(s)"
            )
        if rule.get("uniqueItems"):
            serialized = [
                json.dumps(item, ensure_ascii=False, sort_keys=True) for item in value
            ]
            if len(serialized) != len(set(serialized)):
                errors.append(f"{path}: items must be unique")
        item_rule = rule.get("items")
        if isinstance(item_rule, dict):
            for index, item in enumerate(value):
                _validate_schema_value(
                    item, item_rule, root_schema, f"{path}[{index}]", errors
                )
        return

    if isinstance(value, str):
        length = len(value)
        if length < rule.get("minLength", 0):
            errors.append(
                f"{path}: must contain at least {rule['minLength']} character(s)"
            )
        if "maxLength" in rule and length > rule["maxLength"]:
            errors.append(
                f"{path}: must contain at most {rule['maxLength']} character(s)"
            )
        if "pattern" in rule and re.search(rule["pattern"], value) is None:
            errors.append(f"{path}: does not match the required format")
        return

    if expected_type == "integer":
        if "minimum" in rule and value < rule["minimum"]:
            errors.append(f"{path}: must be at least {rule['minimum']}")
        if "maximum" in rule and value > rule["maximum"]:
            errors.append(f"{path}: must be at most {rule['maximum']}")


def _matches_json_type(value: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "null":
        return value is None
    return False


def _normalize_key(key: str) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", key.casefold())


def _scan_sensitive_content(value: Any, path: str, errors: list[str]) -> None:
    if isinstance(value, dict):
        for key in sorted(value):
            child_path = f"{path}.{key}"
            normalized = _normalize_key(key)
            if any(marker in normalized for marker in SENSITIVE_KEY_MARKERS):
                errors.append(f"{child_path}: sensitive field is forbidden")
            _scan_sensitive_content(value[key], child_path, errors)
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _scan_sensitive_content(item, f"{path}[{index}]", errors)
        return
    if not isinstance(value, str):
        return
    if SENSITIVE_ASSIGNMENT_PATTERN.search(value) or AUTHORIZATION_VALUE_PATTERN.search(
        value
    ):
        errors.append(f"{path}: appears to contain a sensitive value")
        return
    if value.lower().startswith(("http://", "https://")):
        try:
            parsed = urlsplit(value)
        except ValueError:
            return
        if parsed.username is not None or parsed.password is not None:
            errors.append(f"{path}: URL user information is forbidden")


def _validate_profile_semantics(
    profile: dict[str, Any], errors: list[str], project_root: Path | None
) -> None:
    if "display_name" in profile:
        try:
            validate_display_name(profile["display_name"])
        except ValueError as error:
            errors.append(f"$.display_name: {error}")
    app_id = profile.get("app_id")
    if isinstance(app_id, str) and not APP_ID_PATTERN.fullmatch(app_id):
        # The schema emits the user-facing format error. Avoid a duplicate here.
        app_id = None

    parsed_urls: dict[str, SplitResult] = {}
    for field in (
        "cloudbase_origin",
        "telemetry_endpoint",
        "application_version_base_url",
    ):
        value = profile.get(field)
        if isinstance(value, str):
            parsed = _validate_https_url(value, f"$.{field}", errors)
            if parsed is not None:
                parsed_urls[field] = parsed
                hostname = (parsed.hostname or "").casefold().rstrip(".")
                approved_version_gateway = (
                    field == "application_version_base_url"
                    and value in APPROVED_APPLICATION_VERSION_BASE_URLS
                )
                if (
                    not hostname.endswith(".app.tcloudbase.com")
                    and not approved_version_gateway
                ):
                    errors.append(
                        f"$.{field}: the zero-cost path requires a confirmed "
                        "CloudBase default HTTPS gateway domain ending "
                        ".app.tcloudbase.com or an exact approved application-version "
                        "gateway; custom or example domains are blocked"
                    )

    origin = parsed_urls.get("cloudbase_origin")
    if origin is not None and origin.path not in ("", "/"):
        errors.append("$.cloudbase_origin: must not contain a path")

    telemetry = parsed_urls.get("telemetry_endpoint")
    if telemetry is not None:
        match = TRACK_PATH_PATTERN.fullmatch(telemetry.path)
        if match is None:
            errors.append(
                "$.telemetry_endpoint: path must be /apps/<app_id>/v1/track"
            )
        elif app_id is None:
            errors.append("$.telemetry_endpoint: app_id is required for consistency")
        elif match.group(1) != app_id:
            errors.append("$.telemetry_endpoint: path does not match app_id")

    application_version_base = parsed_urls.get("application_version_base_url")
    if application_version_base is not None:
        if application_version_base.path != APPLICATION_VERSION_API_PATH:
            errors.append(
                "$.application_version_base_url: path must be exactly "
                "/tools/version-control/v1 with one v1 segment"
            )
        if "/v1/v1" in application_version_base.path:
            errors.append(
                "$.application_version_base_url: duplicate /v1/v1 is forbidden"
            )

    if origin is not None:
        telemetry = parsed_urls.get("telemetry_endpoint")
        if telemetry is not None and _url_origin(telemetry) != _url_origin(origin):
            errors.append("$.telemetry_endpoint: origin does not match cloudbase_origin")
        application_version_base = parsed_urls.get("application_version_base_url")
        if (
            application_version_base is not None
            and _url_origin(application_version_base) != _url_origin(origin)
            and profile.get("application_version_base_url")
            not in APPROVED_APPLICATION_VERSION_BASE_URLS
        ):
            errors.append(
                "$.application_version_base_url: origin does not match "
                "cloudbase_origin or an exact approved application-version gateway"
            )

    gates = profile.get("deployment_gates")
    if not isinstance(gates, dict):
        gates = {}
    registration_status = profile.get("registration_status")
    app_registered = gates.get("app_registered")
    if registration_status in ("registered", "verified") and app_registered is False:
        errors.append(
            "$.deployment_gates.app_registered: conflicts with registration_status"
        )
    if registration_status == "not_registered" and app_registered is True:
        errors.append(
            "$.deployment_gates.app_registered: conflicts with registration_status"
        )

    if gates.get("profile_complete") is True:
        _require_complete_profile(profile, errors)

    _validate_release_streams(profile, errors)
    _validate_version_api_auth(profile, gates, errors)
    _validate_legacy_update_removal(profile, gates, errors)
    _validate_gate_dependencies(gates, errors)

    sdk_distribution = profile.get("sdk_distribution")
    if isinstance(sdk_distribution, dict):
        source = sdk_distribution.get("source")
        if isinstance(source, str) and not _is_safe_relative_sdk_source(source):
            errors.append(
                "$.sdk_distribution.source: must be a fixed, project-relative "
                "source or versioned package spec, not an absolute or escaping path"
            )
        verification_evidence = sdk_distribution.get("verification_evidence")
        if isinstance(verification_evidence, str) and not _is_safe_relative_sdk_source(
            verification_evidence
        ):
            errors.append(
                "$.sdk_distribution.verification_evidence: must be a fixed, "
                "project-relative path"
            )
        if sdk_distribution.get("kind") == "private_package":
            for field in ("verification_evidence", "immutable_reference"):
                if field not in sdk_distribution:
                    errors.append(
                        f"$.sdk_distribution.{field}: required for private_package"
                    )
            version = sdk_distribution.get("version")
            if isinstance(source, str) and isinstance(version, str):
                expected_source = f"@bifang/telemetry-update-sdk@{version}"
                if source != expected_source:
                    errors.append(
                        "$.sdk_distribution.source: private_package must use the "
                        f"exact immutable package spec {expected_source}"
                    )

    stage = profile.get("current_stage")
    if isinstance(stage, int) and not isinstance(stage, bool) and 1 <= stage <= 8:
        if stage >= 2:
            _require_complete_profile(profile, errors)
        for gate in STAGE_PREREQUISITE_GATES.get(stage, ()):
            if gates.get(gate) is not True:
                errors.append(
                    f"$.deployment_gates.{gate}: must be true before stage {stage}"
                )
        if stage in (3, 4, 6, 7, 8) and registration_status not in (
            "registered",
            "verified",
        ):
            errors.append(
                "$.registration_status: must be registered or verified before stage 3"
            )
        framework = profile.get("framework")
        requires_node_sdk = (
            stage in (5, 6, 7)
            and isinstance(framework, str)
            and re.search(
                r"(?i)(?:^|[^a-z0-9])"
                r"(?:node(?:\.?js)?|electron(?:\.?js)?|nw(?:\.?js)?)"
                r"(?:$|[^a-z0-9])",
                framework,
            )
            is not None
        )
        if requires_node_sdk:
            if gates.get("sdk_distribution_ready") is not True:
                errors.append(
                    "$.deployment_gates.sdk_distribution_ready: must be true "
                    "before Node/Electron stage 5"
                )
            if not isinstance(sdk_distribution, dict):
                errors.append(
                    "$.sdk_distribution: required before Node/Electron stage 5"
                )
            if "sdk_artifact_sha256" not in profile:
                errors.append(
                    "$.sdk_artifact_sha256: required before Node/Electron stage 5"
                )
            if (
                gates.get("sdk_distribution_ready") is True
                and isinstance(sdk_distribution, dict)
                and isinstance(profile.get("sdk_artifact_sha256"), str)
            ):
                if project_root is None:
                    errors.append(
                        "$.deployment_gates.sdk_distribution_ready: offline artifact "
                        "verification requires the target project root"
                    )
                else:
                    try:
                        from verify_sdk_distribution import (
                            SDKDistributionVerificationError,
                            verify_sdk_distribution,
                        )

                        verify_sdk_distribution(profile, project_root)
                    except (SDKDistributionVerificationError, OSError, ValueError) as error:
                        errors.append(
                            "$.deployment_gates.sdk_distribution_ready: offline SDK "
                            f"distribution verification failed: {error}"
                        )


def _validate_https_url(
    value: str, path: str, errors: list[str]
) -> SplitResult | None:
    if any(character.isspace() or ord(character) < 32 for character in value):
        errors.append(f"{path}: must be a clean HTTPS URL")
        return None
    if "\\" in value:
        errors.append(f"{path}: backslashes are not allowed in a URL")
        return None
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        errors.append(f"{path}: must be a valid HTTPS URL")
        return None
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        errors.append(
            f"{path}: must be HTTPS without credentials, query, or fragment"
        )
        return None
    normalized_host = hostname.casefold().rstrip(".")
    if normalized_host in ("localhost",) or normalized_host.endswith(
        (".localhost", ".local", ".internal")
    ):
        errors.append(f"{path}: must use a public HTTPS host")
        return None
    try:
        address = ipaddress.ip_address(normalized_host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        errors.append(f"{path}: must use a public HTTPS host")
        return None
    if port not in (None, 443):
        errors.append(f"{path}: only the standard HTTPS port is allowed")
        return None
    return parsed


def _url_origin(parsed: SplitResult) -> tuple[str, str, int]:
    return (parsed.scheme, (parsed.hostname or "").casefold().rstrip("."), 443)


def _require_complete_profile(
    profile: dict[str, Any], errors: list[str]
) -> None:
    required_fields = [*PROFILE_COMPLETION_FIELDS, *PROFILE_V2_COMPLETION_FIELDS]
    for field in required_fields:
        if field not in profile:
            errors.append(f"$.{field}: required for a complete onboarding profile")
    if "product_purpose" not in profile and "product_key" not in profile:
        errors.append(
            "$.product_purpose: product_purpose or product_key is required for a complete onboarding profile"
        )


def _validate_gate_dependencies(
    gates: dict[str, Any], errors: list[str]
) -> None:
    dependencies = {
        "client_integration_complete": ("telemetry_app_version_verified",),
        "telemetry_app_version_verified": ("profile_complete",),
        "telemetry_app_version_online_verified": (
            "telemetry_app_version_verified",
            "function_deployed",
            "route_deployed",
        ),
        "app_display_name_registered": ("profile_complete", "app_id_confirmed"),
        "dashboard_display_name_verified": (
            "app_registered",
            "app_display_name_registered",
            "cloudbase_config_reviewed",
        ),
        "cloudbase_config_reviewed": ("app_registered",),
        "function_deployed": ("cloudbase_config_reviewed",),
        "collection_created": ("cloudbase_config_reviewed",),
        "collection_admin_only": ("collection_created",),
        "route_deployed": ("function_deployed",),
        "online_e2e_passed": (
            "function_deployed",
            "route_deployed",
        ),
        "client_e2e_passed": ("client_integration_complete",),
        "version_api_config_reviewed": (
            "app_registered",
            "platform_code_mapping_confirmed",
        ),
        "runtime_auth_ready": ("version_api_config_reviewed",),
        "version_api_service_verified": (
            "version_api_config_reviewed",
            "runtime_auth_ready",
        ),
        "version_api_client_integrated": ("client_integration_complete",),
        "version_api_client_e2e_passed": (
            "version_api_client_integrated",
            "version_api_service_verified",
            "runtime_auth_ready",
        ),
        "migration_observation_complete": (
            "client_e2e_passed",
            "version_api_client_e2e_passed",
        ),
        "legacy_client_update_removed": (
            "client_integration_complete",
            "version_api_client_integrated",
        ),
        "legacy_cloud_resources_removed": (
            "migration_observation_complete",
            "legacy_usage_assessed",
            "owner_approved",
            "legacy_client_update_removed",
        ),
    }
    for gate, prerequisites in dependencies.items():
        if gates.get(gate) is not True:
            continue
        for prerequisite in prerequisites:
            if gates.get(prerequisite) is not True:
                errors.append(
                    f"$.deployment_gates.{prerequisite}: must be true when {gate} is true"
                )


def _validate_release_streams(profile: dict[str, Any], errors: list[str]) -> None:
    streams = profile.get("release_streams")
    if not isinstance(streams, list):
        return
    seen_codes: dict[str, int] = {}
    seen_targets: dict[tuple[str, str, str], int] = {}
    covered_platforms: set[str] = set()
    covered_architectures: set[str] = set()
    declared_platforms = set(profile.get("platforms", []))
    declared_architectures = set(profile.get("architectures", []))
    for index, stream in enumerate(streams):
        if not isinstance(stream, dict):
            continue
        platform = stream.get("platform")
        architecture = stream.get("architecture")
        channel = stream.get("channel")
        code = stream.get("code")
        if isinstance(platform, str):
            covered_platforms.add(platform)
            if declared_platforms and platform not in declared_platforms:
                errors.append(
                    f"$.release_streams[{index}].platform: is not declared in $.platforms"
                )
        if isinstance(architecture, str):
            covered_architectures.add(architecture)
            if declared_architectures and architecture not in declared_architectures:
                errors.append(
                    f"$.release_streams[{index}].architecture: is not declared in $.architectures"
                )
        if isinstance(code, str):
            if code in seen_codes:
                errors.append(
                    f"$.release_streams[{index}].code: duplicate release code also used "
                    f"at $.release_streams[{seen_codes[code]}].code"
                )
            else:
                seen_codes[code] = index
        if all(isinstance(value, str) for value in (platform, architecture, channel)):
            target = (platform, architecture, channel)
            if target in seen_targets:
                errors.append(
                    f"$.release_streams[{index}]: duplicate platform/architecture/channel "
                    f"mapping also used at $.release_streams[{seen_targets[target]}]"
                )
            else:
                seen_targets[target] = index

    if _profile_is_complete(profile):
        for platform in sorted(declared_platforms - covered_platforms):
            errors.append(
                f"$.release_streams: missing a release stream for declared platform {platform!r}"
            )
        for architecture in sorted(declared_architectures - covered_architectures):
            errors.append(
                "$.release_streams: missing a release stream for declared "
                f"architecture {architecture!r}"
            )


def _validate_version_api_auth(
    profile: dict[str, Any], gates: dict[str, Any], errors: list[str]
) -> None:
    binding_id = profile.get("version_api_auth_binding_id")
    status = profile.get("version_api_auth_status")
    if binding_id is not None and status is None:
        errors.append(
            "$.version_api_auth_status: required when version_api_auth_binding_id is present"
        )
    if status in ("ready", "verified") and not isinstance(binding_id, str):
        errors.append(
            "$.version_api_auth_binding_id: required for ready or verified auth status"
        )
    if gates.get("runtime_auth_ready") is True:
        if status != "verified":
            errors.append(
                "$.version_api_auth_status: must be verified when runtime_auth_ready is true"
            )
        if not isinstance(binding_id, str):
            errors.append(
                "$.version_api_auth_binding_id: required when runtime_auth_ready is true"
            )


def _validate_legacy_update_removal(
    profile: dict[str, Any], gates: dict[str, Any], errors: list[str]
) -> None:
    status = profile.get("legacy_update_status")
    removed_gate = gates.get("legacy_client_update_removed")
    if removed_gate is True and status != "removed":
        errors.append(
            "$.legacy_update_status: must be removed when legacy_client_update_removed is true"
        )
    if status == "removed" and removed_gate is not True:
        errors.append(
            "$.deployment_gates.legacy_client_update_removed: must be true when "
            "legacy_update_status is removed"
        )
    stage = profile.get("current_stage")
    if isinstance(stage, int) and not isinstance(stage, bool) and stage == 8:
        if gates.get("legacy_cloud_resources_removed") is not True:
            errors.append(
                "$.deployment_gates.legacy_cloud_resources_removed: must be true before stage 8 is complete"
            )


def _profile_is_complete(profile: dict[str, Any]) -> bool:
    gates = profile.get("deployment_gates")
    stage = profile.get("current_stage")
    return (
        isinstance(gates, dict)
        and gates.get("profile_complete") is True
    ) or (isinstance(stage, int) and not isinstance(stage, bool) and stage >= 2)


def _is_safe_relative_sdk_source(source: str) -> bool:
    if (
        source.startswith(("/", "\\", "~"))
        or re.match(r"^[A-Za-z]:[\\/]", source)
        or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", source)
        or re.search(r"%[^%]+%|\$\{[^}]+\}|\$\([^)]*\)|\$[A-Za-z_]", source)
        or any(character in source for character in "*?[]")
        or "\0" in source
    ):
        return False
    normalized = source.replace("\\", "/")
    return all(part != ".." for part in normalized.split("/"))


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate .bifang/public-services-profile.json locally."
    )
    parser.add_argument("profile", type=Path, help="path to the profile JSON file")
    parser.add_argument("--require-update-center", action="store_true", help="reject legacy application-version profiles for new onboarding")
    return parser.parse_args(argv)


def _default_project_root(profile_path: Path) -> Path:
    parent = profile_path.resolve().parent
    return parent.parent if parent.name == ".bifang" else parent


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    try:
        profile = read_json_file(args.profile)
        schema = load_schema()
    except (OSError, ValueError) as error:
        print(f"profile could not be read: {error}", file=sys.stderr)
        return 2

    errors = validate_profile(
        profile,
        schema,
        project_root=_default_project_root(args.profile),
        require_update_center=args.require_update_center,
    )
    if errors:
        print("profile validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print("profile is valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
