import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  deriveAppResources,
  validateRegistry,
} from "./generate-cloudbaserc.mjs";

const defaultRegistryUrl = new URL("./apps.json", import.meta.url);
const ENV_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

export function createAppDeploymentPlan(registry, appId, { envId, origin }) {
  const applications = validateRegistry(registry);
  const application = applications.find(
    (candidate) => candidate.appId === appId,
  );
  if (!application) {
    throw new TypeError(`app_id is not registered: ${appId}`);
  }
  if (typeof envId !== "string" || !ENV_ID_PATTERN.test(envId)) {
    throw new TypeError("env_id must be a plain CloudBase environment id");
  }
  const domain = readDefaultCloudBaseDomain(origin);
  const resources = deriveAppResources(appId);
  const route = {
    path: resources.trackPath,
    upstreamResourceType: "SCF",
    upstreamResourceName: resources.functionName,
    enable: true,
    enableAuth: false,
    enableSafeDomain: true,
    enablePathTransmission: true,
    qpsPolicy: {
      qpsTotal: 100,
      qpsPerClient: {
        limitBy: "ClientIP",
        limitValue: 10,
      },
    },
  };
  const routeApiBody = JSON.stringify({
    EnvId: envId,
    Domain: {
      Domain: domain,
      Routes: [toCloudBaseApiRoute(route)],
    },
  });
  const storagePathTemplate = `telemetry/${appId}/{active_date}.json`;

  return {
    schema_version: 2,
    mode: "telemetry-target-only-preview",
    requires_stage_4_confirmation: true,
    env_id: envId,
    origin: `https://${domain}`,
    app_id: appId,
    resources: {
      function: resources.functionName,
      storage_backend: "storage",
      telemetry_storage_path_template: storagePathTemplate,
      route,
    },
    release_streams: application.releaseStreams.map((stream) => ({
      ...stream,
    })),
    excluded_app_ids: applications
      .map(({ appId: registeredAppId }) => registeredAppId)
      .filter((registeredAppId) => registeredAppId !== appId),
    read_only_preflight: [
      {
        resource: "functions",
        argv: ["tcb", "fn", "list", "-e", envId, "--limit", "100", "--json"],
      },
      {
        resource: "routes",
        argv: [
          "tcb",
          "routes",
          "list",
          "-e",
          envId,
          "--limit",
          "1000",
          "--filter",
          `Domain=${domain}`,
          "--json",
        ],
      },
      {
        kind: "manual-read-only",
        resource: "storage-and-cost",
        instruction: `Verify CloudBase cloud storage is available for ${storagePathTemplate} and confirm the existing environment remains zero-cost with overrun disabled. Do not create PostgreSQL collections or TTL indexes. Stop on incomplete inventory, non-zero amount, upgrade prompt or insufficient quota.`,
      },
    ],
    write_steps_after_confirmation: [
      {
        kind: "command",
        resource: "function",
        argv: [
          "tcb",
          "fn",
          "deploy",
          resources.functionName,
          "--config-file",
          "cloudbaserc.example.json",
          "-e",
          envId,
          "--json",
        ],
      },
      {
        kind: "command",
        resource: "route",
        argv: [
          "tcb",
          "api",
          "tcb",
          "CreateHTTPServiceRoute",
          "--api-version",
          "2018-06-08",
          "--body",
          routeApiBody,
          "--json",
        ],
      },
    ],
    post_write_verification: [
      `DescribeHTTPServiceRoute must return exactly ${route.path} -> ${resources.functionName} for the selected domain.`,
      `A valid daily_active request must write to CloudBase cloud storage (${storagePathTemplate}), an identical retry must remain idempotent, and PostgreSQL CU usage must remain 0.`,
    ],
    safety_notes: [
      "fn deploy is explicitly bound to the reviewed env_id and tracked cloudbaserc.example.json.",
      "The platform default domain is created through the exact CreateHTTPServiceRoute API because routes add rejects system default domains during its custom-domain verification step.",
      "Telemetry writes directly to CloudBase cloud storage (COS) with warm-instance deduplication instead of PostgreSQL collections to avoid 5-minute CU billing.",
      "Release streams are displayed for identity review only; this telemetry-only plan never writes the shared application-version service.",
    ],
    forbidden_scope: [
      "tcb deploy",
      "tcb deploy --only=gateway",
      "tcb fn deploy --all",
      "PostgreSQL collections or TTL indexes",
      "application-version-api function, route or collections",
      "hosting writes",
      "--force",
      "--prune",
      "delete commands",
      "paid plans, resource packs or overage",
    ],
  };
}

function toCloudBaseApiRoute(route) {
  return {
    Path: route.path,
    UpstreamResourceType: route.upstreamResourceType,
    UpstreamResourceName: route.upstreamResourceName,
    Enable: route.enable,
    EnableAuth: route.enableAuth,
    EnableSafeDomain: route.enableSafeDomain,
    EnablePathTransmission: route.enablePathTransmission,
    QPSPolicy: {
      QPSTotal: route.qpsPolicy.qpsTotal,
      QPSPerClient: {
        LimitBy: route.qpsPolicy.qpsPerClient.limitBy,
        LimitValue: route.qpsPolicy.qpsPerClient.limitValue,
      },
    },
  };
}

export async function planAppDeployment(appId, options = {}) {
  const registryUrl = options.registryUrl || defaultRegistryUrl;
  const registry = JSON.parse(await readFile(registryUrl, "utf8"));
  return createAppDeploymentPlan(registry, appId, options);
}

function readDefaultCloudBaseDomain(origin) {
  if (typeof origin !== "string") {
    throw new TypeError("origin must be a CloudBase default HTTPS origin");
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError("origin must be a CloudBase default HTTPS origin");
  }
  const domain = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !domain.endsWith(".app.tcloudbase.com")
  ) {
    throw new TypeError("origin must be a CloudBase default HTTPS origin");
  }
  return domain;
}

function parseArguments(args) {
  if (args.length !== 5 || args[1] !== "--env-id" || args[3] !== "--origin") {
    throw new TypeError(
      "usage: npm run cloudbase:app:deploy:plan -- <app_id> --env-id <env_id> --origin <https_origin>",
    );
  }
  return {
    appId: args[0],
    envId: args[2],
    origin: args[4],
  };
}

async function main() {
  const { appId, envId, origin } = parseArguments(process.argv.slice(2));
  const plan = await planAppDeployment(appId, { envId, origin });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

const isMain =
  process.argv[1] &&
  import.meta.url.toLowerCase() ===
    pathToFileURL(resolve(process.argv[1])).href.toLowerCase();

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
