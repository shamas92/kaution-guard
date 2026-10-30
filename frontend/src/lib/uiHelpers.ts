/**
 * Small shared UI constants and value helpers, extracted from the old
 * single-page component so every route uses one definition.
 */

export const FALLBACK_JURISDICTIONS = ["GLOBAL_AUTO", "DE", "UK", "US_NY", "FR", "JP"];

export const LANGUAGES = [
  { code: "de", label: "Deutsch" },
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "ja", label: "日本語" },
];

export const NOT_PROVIDED = "Not provided by backend";

/**
 * Friendly display names for jurisdiction codes. Option *values* stay
 * the backend codes; only the visible label changes.
 */
const JURISDICTION_LABELS: Record<string, string> = {
  GLOBAL_AUTO: "Detect automatically",
  DE: "Germany",
  UK: "United Kingdom",
  US_NY: "New York (USA)",
  FR: "France",
  JP: "Japan",
};

export function jurisdictionLabel(code: string): string {
  return JURISDICTION_LABELS[code] ?? code;
}

export function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number") return String(value);
  return null;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function ratio(used: number, max: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, used / max));
}
