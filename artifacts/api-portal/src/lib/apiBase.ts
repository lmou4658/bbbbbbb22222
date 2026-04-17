const isDev =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" ||
    window.location.hostname.endsWith(".replit.dev") ||
    window.location.hostname.endsWith(".spock.replit.dev") ||
    window.location.hostname.endsWith(".kirk.replit.dev"));

export const API_BASE: string =
  import.meta.env.VITE_API_BASE ?? window.location.origin;

export const DISPLAY_BASE_URL: string = API_BASE + "/api";

export { isDev };
