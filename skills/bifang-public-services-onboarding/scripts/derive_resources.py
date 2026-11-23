#!/usr/bin/env python3
"""Derive isolated Bifang resource names locally and deterministically."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable

from validate_profile import (
    APP_ID_PATTERN,
    APPROVED_APPLICATION_VERSION_BASE_URLS,
    read_json_file,
    validate_display_name,
    validate_profile,
)


SUPPORTED_PLATFORMS = frozenset(("windows", "macos", "linux"))
APPLICATION_VERSION_CONTRACT_VERSION = "1.0.0"
APPLICATION_VERSION_API_ROUTE = "/tools/version-control/v1"
APPLICATION_VERSION_FUNCTION_NAME = "application-version-api"
RELEASE_CODE_PATTERN = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$"
)


def derive_resources(
    app_id: str,
    platforms: Iterable[str] = (),
    *,
    cloudbase_origin: str | None = None,
    application_version_base_url: str | None = None,
    release_streams: Iterable[dict[str, Any]] = (),
    legacy_update_status: str | None = None,
    display_name: str | None = None,
) -> dict[str, Any]:
    """Return the complete collision-free resource mapping for an app id."""

    if not isinstance(app_id, str) or APP_ID_PATTERN.fullmatch(app_id) is None:
        raise ValueError(
            "app_id must be 1-50 lowercase letters, digits, or hyphens and "
            "must start and end with a letter or digit"
        )
    platform_list = sorted(set(platforms))
    for platform in platform_list:
        if platform not in SUPPORTED_PLATFORMS:
            raise ValueError(
                "platform must be one of: windows, macos, linux"
            )

    telemetry_route = f"/apps/{app_id}/v1/track"
    normalized_app_id = app_id.replace("-", "_")
    normalized_streams = _normalize_release_streams(release_streams)
    stream_platforms = {stream["platform"] for stream in normalized_streams}
    platform_gates = {
        platform: {
            "status": "ready" if platform in stream_platforms else "pending",
            "reason": (
                "application-version API release stream code is declared"
                if platform in stream_platforms
                else "application-version API release stream code is not yet declared"
            ),
        }
        for platform in platform_list
    }
    resources: dict[str, Any] = {
        "app_id": app_id,
        "storage_backend": "storage",
        "telemetry_storage_path_template": f"telemetry/{app_id}/{{active_date}}.json",
        "version_storage_path": f"version-control/{app_id}/versions.json",
        "ad_storage_path": f"version-control/{app_id}/ads.json",
        "audit_storage_path": f"version-control/{app_id}/audit.json",
        "collection_name": f"telemetry_{normalized_app_id}",
        "function_name": f"telemetry-{app_id}",
        "platform_gates": platform_gates,
        "telemetry_route": telemetry_route,
        "application_version_contract_version": APPLICATION_VERSION_CONTRACT_VERSION,
        "application_version_function_name": APPLICATION_VERSION_FUNCTION_NAME,
        "application_version_route": APPLICATION_VERSION_API_ROUTE,
        "version_collection_name": f"versions_{normalized_app_id}",
        "ad_collection_name": f"ads_{normalized_app_id}",
        "audit_collection_name": f"audit_{normalized_app_id}",
        "release_streams": [
            {
                **stream,
                "version_check_path_template": (
                    f"{APPLICATION_VERSION_API_ROUTE}/versions/{stream['code']}/{{version}}"
                ),
                "ads_show_path": (
                    f"{APPLICATION_VERSION_API_ROUTE}/app/{stream['code']}/ads/show"
                ),
            }
            for stream in normalized_streams
        ],
    }

    if display_name is not None:
        validate_display_name(display_name)
        resources["display_name"] = display_name
        resources["dashboard_app_labels"] = {app_id: display_name}

    if legacy_update_status is not None:
        resources["legacy_update_status"] = legacy_update_status

    if cloudbase_origin is not None:
        origin = cloudbase_origin.rstrip("/")
        expected_version_base = f"{origin}{APPLICATION_VERSION_API_ROUTE}"
        if (
            application_version_base_url is not None
            and application_version_base_url != expected_version_base
            and application_version_base_url
            not in APPROVED_APPLICATION_VERSION_BASE_URLS
        ):
            raise ValueError(
                "application_version_base_url must equal cloudbase_origin plus "
                "/tools/version-control/v1 or an exact approved application-version "
                "gateway"
            )
        version_base = application_version_base_url or expected_version_base
        resources.update(
            {
                "telemetry_endpoint": f"{origin}{telemetry_route}",
                "application_version_base_url": version_base,
            }
        )
        for stream in resources["release_streams"]:
            stream["version_check_url_template"] = (
                f"{version_base}/versions/{stream['code']}/{{version}}"
            )
            stream["ads_show_url"] = (
                f"{version_base}/app/{stream['code']}/ads/show"
            )
    return resources


def _normalize_release_streams(
    release_streams: Iterable[dict[str, Any]],
) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    seen_codes: set[str] = set()
    seen_targets: set[tuple[str, str, str]] = set()
    for stream in release_streams:
        if not isinstance(stream, dict):
            raise ValueError("release_streams entries must be objects")
        if set(stream) != {"platform", "architecture", "channel", "code"}:
            raise ValueError(
                "release_streams entries require only platform, architecture, channel, and code"
            )
        platform = stream.get("platform")
        architecture = stream.get("architecture")
        channel = stream.get("channel")
        code = stream.get("code")
        if platform not in SUPPORTED_PLATFORMS:
            raise ValueError(
                "release stream platform must be windows, macos, or linux"
            )
        if architecture not in {"x64", "arm64", "ia32"}:
            raise ValueError("release stream architecture must be x64, arm64, or ia32")
        if not isinstance(channel, str) or not re.fullmatch(
            r"[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?", channel
        ):
            raise ValueError("release stream channel is invalid")
        if not isinstance(code, str) or RELEASE_CODE_PATTERN.fullmatch(code) is None:
            raise ValueError(
                "release stream code must be globally unique, URL-safe, and 1-50 characters"
            )
        target = (platform, architecture, channel)
        if code in seen_codes:
            raise ValueError(f"duplicate release stream code: {code}")
        if target in seen_targets:
            raise ValueError(
                "duplicate release stream platform/architecture/channel mapping"
            )
        seen_codes.add(code)
        seen_targets.add(target)
        normalized.append(
            {
                "platform": platform,
                "architecture": architecture,
                "channel": channel,
                "code": code,
            }
        )
    return sorted(
        normalized,
        key=lambda stream: (
            stream["platform"],
            stream["architecture"],
            stream["channel"],
            stream["code"],
        ),
    )


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Derive per-app CloudBase resources without writing or deploying."
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("app_id", nargs="?", help="confirmed application id")
    source.add_argument(
        "--profile",
        type=Path,
        help="validated .bifang/public-services-profile.json",
    )
    parser.add_argument(
        "--display-name",
        help="confirmed Chinese product name for an app-id-only preview",
    )
    parser.add_argument(
        "--platform",
        action="append",
        default=[],
        help="release-stream platform to derive; repeat for more than one platform",
    )
    return parser.parse_args(argv)


def _load_profile(path: Path) -> dict[str, Any]:
    profile = read_json_file(path)
    parent = path.resolve().parent
    project_root = parent.parent if parent.name == ".bifang" else parent
    errors = validate_profile(profile, project_root=project_root)
    if errors:
        formatted = "\n".join(f"- {error}" for error in errors)
        raise ValueError(f"profile validation failed:\n{formatted}")
    if not isinstance(profile, dict):
        raise ValueError("profile must contain an object")
    return profile


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    try:
        if args.profile is not None:
            if args.display_name is not None:
                raise ValueError(
                    "--display-name cannot override a Profile; "
                    "confirm its display_name instead"
                )
            profile = _load_profile(args.profile)
            if profile.get("profile_schema_version") != 2:
                raise ValueError(
                    "legacy profile schema v1 was recognized read-only; explicitly migrate "
                    "it to profile_schema_version 2 before deriving application-version API resources"
                )
            app_id = profile.get("app_id")
            if not isinstance(app_id, str):
                raise ValueError("profile does not yet contain a confirmed app_id")
            if profile.get("update_transport") == "client-update-center-v1":
                if args.platform:
                    raise ValueError("--platform cannot override Profile update_targets")
                validate_display_name(profile.get("display_name"))
                normalized = app_id.replace("-", "_")
                route = f"/apps/{app_id}/v1/track"
                origin = profile.get("cloudbase_origin")
                update_origin = profile.get("update_center_base_url", "https://update.meetelf.com").rstrip("/")
                resources = {
                    "app_id": app_id,
                    "display_name": profile["display_name"],
                    "dashboard_app_labels": {app_id: profile["display_name"]},
                    "storage_backend": "storage",
                    "telemetry_storage_path_template": f"telemetry/{app_id}/{{active_date}}.json",
                    "function_name": f"telemetry-{app_id}",
                    "collection_name": f"telemetry_{normalized}",
                    "telemetry_route": route,
                    "update_transport": "client-update-center-v1",
                    "update_center_base_url": update_origin,
                    "update_check_url": f"{update_origin}/api/v1/apps/{app_id}/update-checks",
                    "update_targets": profile.get("update_targets", []),
                    "offline_enforcement": profile.get("offline_enforcement"),
                }
                if isinstance(origin, str):
                    resources["telemetry_endpoint"] = origin.rstrip("/") + route
                print(json.dumps(resources, ensure_ascii=False, indent=2, sort_keys=True))
                return 0
            platforms = args.platform or profile.get("platforms", [])
            cloudbase_origin = profile.get("cloudbase_origin")
            application_version_base_url = profile.get(
                "application_version_base_url"
            )
            release_streams = profile.get("release_streams", [])
            legacy_update_status = profile.get("legacy_update_status")
            display_name = profile.get("display_name")
            validate_display_name(display_name)
        else:
            app_id = args.app_id
            platforms = args.platform
            cloudbase_origin = None
            application_version_base_url = None
            release_streams = []
            legacy_update_status = None
            display_name = args.display_name

        resources = derive_resources(
            app_id,
            platforms,
            cloudbase_origin=cloudbase_origin,
            application_version_base_url=application_version_base_url,
            release_streams=release_streams,
            legacy_update_status=legacy_update_status,
            display_name=display_name,
        )
    except (OSError, ValueError) as error:
        print(f"resource derivation failed: {error}", file=sys.stderr)
        return 1

    print(json.dumps(resources, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
