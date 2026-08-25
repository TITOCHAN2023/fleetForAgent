import {
  OFFICIAL_PLUGIN_CATALOG,
  PLUGIN_REGISTRY_SOURCE,
} from "../../../packages/fleet-tool/official-plugins.generated.mjs";

export type PluginPlatform = {
  os: "darwin" | "linux" | "windows";
  arch: "amd64" | "arm64";
};

export type OfficialPlugin = {
  schema_version: 1;
  id: string;
  order: number;
  name: string;
  version: string;
  publisher: string;
  license: string;
  repository: string;
  homepage: string;
  categories: string[];
  description: { en: string; zh: string };
  installable: boolean;
  actions: string[];
  artifacts: Array<PluginPlatform & { url: string; sha256: string; entrypoint: string }>;
  source_file: string;
  body: string;
};

export const officialPlugins = OFFICIAL_PLUGIN_CATALOG as readonly OfficialPlugin[];
export const pluginRegistrySource = PLUGIN_REGISTRY_SOURCE as Readonly<{
  repository: string;
  commit: string;
}>;

