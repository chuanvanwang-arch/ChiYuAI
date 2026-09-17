/**
 * Enterprise AI Sales Decision Expert — OpenClaw plugin entrypoint.
 *
 * This plugin acts as a skill bundle: all CRM capabilities are provided by the
 * declarative skills listed in openclaw.plugin.json#skills. No native runtime
 * registration is required.
 */
export default function crmNativePlugin(api) {
  // Skills are loaded declaratively from openclaw.plugin.json.
  // Native tools/hooks can be registered here if needed in the future.
}
