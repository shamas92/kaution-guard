"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getMeta, type MetaStatus } from "../lib/api";
import {
  loadMoveinRefs,
  storeMoveinRefs,
  MAX_SAVED_REFS,
  type MoveinReference,
} from "../lib/moveinRefs";
import { FALLBACK_JURISDICTIONS, LANGUAGES } from "../lib/uiHelpers";

const JURISDICTION_STORAGE_KEY = "kautionguard.shell.jurisdiction.v1";
const LANGUAGE_STORAGE_KEY = "kautionguard.shell.language.v1";

export interface KautionGuardContextValue {
  meta: MetaStatus | null;
  metaError: string | null;
  jurisdictions: string[];
  jurisdiction: string;
  setJurisdiction: (value: string) => void;
  language: string;
  setLanguage: (value: string) => void;

  moveinRefs: MoveinReference[];
  refsHydrated: boolean;
  selectedRefKey: string | null;
  setSelectedRefKey: (key: string | null) => void;
  commitMoveinRefs: (next: MoveinReference[]) => boolean;
  addMoveinRef: (ref: MoveinReference) => boolean;
  removeMoveinRef: (key: string) => void;
}

const KautionGuardContext =
  createContext<KautionGuardContextValue | null>(null);

export function useKautionGuard(): KautionGuardContextValue {
  const value = useContext(KautionGuardContext);
  if (!value) {
    throw new Error(
      "useKautionGuard must be used inside KautionGuardProvider",
    );
  }
  return value;
}

/**
 * Layout-persistent shell state: live budget/meta, the jurisdiction
 * and language selections (persisted across reloads) and the shared
 * saved move-in reference store. Initial values match the
 * server-rendered defaults; persisted values load in effects only.
 */
export default function KautionGuardProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [meta, setMeta] = useState<MetaStatus | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [jurisdiction, setJurisdiction] = useState("GLOBAL_AUTO");
  const [language, setLanguage] = useState("de");
  // Initialized empty so the server and the first client render match;
  // saved references load in an effect after hydration (see below).
  const [moveinRefs, setMoveinRefs] = useState<MoveinReference[]>([]);
  const [refsHydrated, setRefsHydrated] = useState(false);
  const [selectedRefKey, setSelectedRefKey] = useState<string | null>(null);
  // Guards the selection-persistence effect: stored choices must be
  // loaded before any write, or the SSR defaults would overwrite them.
  const [prefsHydrated, setPrefsHydrated] = useState(false);

  useEffect(() => {
    getMeta().then(setMeta).catch((e: unknown) => {
      setMetaError(e instanceof Error ? e.message : "Budget status unavailable");
    });
  }, []);

  // Load saved references after hydration, when localStorage exists.
  // Both state updates apply on the next render, so the persist effect
  // below still sees refsHydrated as false in this commit and cannot
  // overwrite the store with the initial empty list.
  useEffect(() => {
    setMoveinRefs(loadMoveinRefs());
    setRefsHydrated(true);
  }, []);

  // Persist saved move-in references; a full or unavailable store keeps
  // the in-memory list and reports the failure on save instead.
  useEffect(() => {
    if (!refsHydrated) return;
    storeMoveinRefs(moveinRefs);
  }, [moveinRefs, refsHydrated]);

  // Keep the selected reference valid as the list changes.
  useEffect(() => {
    if (
      selectedRefKey &&
      !moveinRefs.some((ref) => ref.key === selectedRefKey)
    ) {
      setSelectedRefKey(moveinRefs[0]?.key ?? null);
    }
  }, [moveinRefs, selectedRefKey]);

  // Load the persisted shell selections once, after first render.
  useEffect(() => {
    try {
      const storedJurisdiction = localStorage.getItem(
        JURISDICTION_STORAGE_KEY,
      );
      if (
        storedJurisdiction &&
        FALLBACK_JURISDICTIONS.includes(storedJurisdiction)
      ) {
        setJurisdiction(storedJurisdiction);
      }
      const storedLanguage = localStorage.getItem(LANGUAGE_STORAGE_KEY);
      if (
        storedLanguage &&
        LANGUAGES.some((l) => l.code === storedLanguage)
      ) {
        setLanguage(storedLanguage);
      }
    } catch {
      /* storage blocked: keep the defaults */
    }
    setPrefsHydrated(true);
  }, []);

  // Persist selections, but only after the load above has run.
  useEffect(() => {
    if (!prefsHydrated) return;
    try {
      localStorage.setItem(JURISDICTION_STORAGE_KEY, jurisdiction);
      localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      /* storage blocked: selections still work for this session */
    }
  }, [jurisdiction, language, prefsHydrated]);

  // If the backend's jurisdiction list arrives and does not contain
  // the current choice, fall back to auto-detect (or the first code).
  useEffect(() => {
    if (!prefsHydrated || !meta) return;
    const available =
      meta.jurisdictions.length > 0
        ? meta.jurisdictions
        : FALLBACK_JURISDICTIONS;
    if (!available.includes(jurisdiction)) {
      setJurisdiction(
        available.includes("GLOBAL_AUTO") ? "GLOBAL_AUTO" : available[0],
      );
    }
  }, [meta, jurisdiction, prefsHydrated]);

  const jurisdictions =
    meta && meta.jurisdictions.length > 0
      ? meta.jurisdictions
      : FALLBACK_JURISDICTIONS;

  const commitMoveinRefs = useCallback(
    (next: MoveinReference[]): boolean => {
      const capped = next.slice(0, MAX_SAVED_REFS);
      setMoveinRefs(capped);
      return storeMoveinRefs(capped);
    },
    [],
  );

  const addMoveinRef = useCallback(
    (ref: MoveinReference): boolean => {
      const stored = commitMoveinRefs([ref, ...moveinRefs]);
      setSelectedRefKey(ref.key);
      return stored;
    },
    [commitMoveinRefs, moveinRefs],
  );

  const removeMoveinRef = useCallback((key: string) => {
    setMoveinRefs((prev) => prev.filter((ref) => ref.key !== key));
  }, []);

  const value: KautionGuardContextValue = useMemo(
    () => ({
      meta,
      metaError,
      jurisdictions,
      jurisdiction,
      setJurisdiction,
      language,
      setLanguage,
      moveinRefs,
      refsHydrated,
      selectedRefKey,
      setSelectedRefKey,
      commitMoveinRefs,
      addMoveinRef,
      removeMoveinRef,
    }),
    [
      meta,
      metaError,
      jurisdictions,
      jurisdiction,
      language,
      moveinRefs,
      refsHydrated,
      selectedRefKey,
      commitMoveinRefs,
      addMoveinRef,
      removeMoveinRef,
    ],
  );

  return (
    <KautionGuardContext.Provider value={value}>
      {children}
    </KautionGuardContext.Provider>
  );
}
