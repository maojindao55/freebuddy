import posthog from "posthog-js/dist/module.full.no-external";

posthog.init(import.meta.env.VITE_POSTHOG_KEY as string, {
  api_host: import.meta.env.VITE_POSTHOG_HOST as string,
  defaults: "2026-05-30",
});

export default posthog;
