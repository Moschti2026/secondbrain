/**
 * OneNote page listing that stays under Graph error 20266.
 *
 * `GET /me/onenote/pages` aggregates every section the user can access and
 * returns 400 / code 20266 once that section count is too high. Microsoft's
 * documented fix is to list sections, then pages for one section at a time
 * (`GET /me/onenote/sections/{id}/pages`), following `@odata.nextLink`.
 * `GET /me/onenote/sections` already includes sections in nested section
 * groups, so this walk does not recurse section groups (that would list
 * the same sections twice).
 *
 * Some sections answer `GET .../sections/{id}/pages` with 422 / code 20258
 * ("Sync of this section is not supported"). Those are remembered on the
 * cursor and skipped until the section's lastModified changes or a week
 * has passed.
 */

const GRAPH_API = "https://graph.microsoft.com/v1.0";
const PAGE_SIZE = 100;

/** Bumped if a stored resume can no longer be interpreted. Cursors without
 * this prefix are the old global `/me/onenote/pages` URL and are discarded,
 * because resuming them hits error 20266 again. */
export const ONENOTE_CURSOR_PREFIX = "on1:";

/** Try a 20258 section again after this long, even if lastModified is unchanged. */
export const ONENOTE_UNSUPPORTED_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

export interface OneNotePage {
  id: string;
  title?: string;
  lastModifiedDateTime?: string;
  links?: { oneNoteWebUrl?: { href?: string } };
}

export interface OneNoteSectionRef {
  id: string;
  displayName: string;
  /** Section `lastModifiedDateTime` when the sections collection sent it. */
  lastModified?: string;
}

/** A section Graph will not sync (422 / code 20258). Stored in the OneNote cursor. */
export interface UnsupportedOneNoteSection {
  id: string;
  displayName: string;
  lastModified: string | null;
  checkedAt: number;
}

export interface OneNoteResume {
  /** Sections-collection URL still to fetch. Null when `pending` is the tail. */
  sectionsUrl: string | null;
  /** Sections from the current page that are not fully ingested yet.
   * The first entry may be partial (`pagesUrl`). */
  pending: OneNoteSectionRef[];
  /** When set, the first pending section continues from this pages URL. */
  pagesUrl: string | null;
}

interface OneNoteSectionRow {
  id?: string;
  displayName?: string;
  name?: string;
  lastModifiedDateTime?: string;
}

interface GraphCollection<T> {
  value?: T[];
  "@odata.nextLink"?: string;
}

export function initialSectionsUrl(): string {
  return `${GRAPH_API}/me/onenote/sections?$top=${PAGE_SIZE}&$select=id,displayName,lastModifiedDateTime`;
}

export function sectionPagesUrl(sectionId: string): string {
  const id = encodeURIComponent(sectionId);
  return `${GRAPH_API}/me/onenote/sections/${id}/pages?$top=${PAGE_SIZE}&$select=id,title,lastModifiedDateTime,links`;
}

export function initialOneNoteResume(): OneNoteResume {
  return { sectionsUrl: initialSectionsUrl(), pending: [], pagesUrl: null };
}

/** True for the sections collection and for `/sections/{id}/pages` only.
 * Graph sometimes rewrites `/me/` to `/users/{id}/` inside `@odata.nextLink`.
 * The global `/onenote/pages` collection is rejected on purpose (error 20266). */
export function isAllowedOneNoteListUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "graph.microsoft.com") return false;
    const path = parsed.pathname.replace(/\/+$/, "");
    const sectionList = /^\/v1\.0\/(?:me|users\/[^/]+)\/onenote\/sections$/;
    const sectionPages = /^\/v1\.0\/(?:me|users\/[^/]+)\/onenote\/sections\/[^/]+\/pages$/;
    return sectionList.test(path) || sectionPages.test(path);
  } catch {
    return false;
  }
}

export function readOneNoteCursor(cursor: string | null | undefined): OneNoteResume {
  const fresh = initialOneNoteResume();
  if (!cursor?.startsWith(ONENOTE_CURSOR_PREFIX)) return fresh;
  try {
    const raw = JSON.parse(cursor.slice(ONENOTE_CURSOR_PREFIX.length)) as Partial<OneNoteResume>;
    const pending = Array.isArray(raw.pending)
      ? raw.pending.flatMap((section) => {
          if (!section || typeof section.id !== "string" || !section.id) return [];
          const ref: OneNoteSectionRef = {
            id: section.id,
            displayName: typeof section.displayName === "string" ? section.displayName : "",
          };
          if (typeof section.lastModified === "string" && section.lastModified) {
            ref.lastModified = section.lastModified;
          }
          return [ref];
        })
      : [];

    let sectionsUrl: string | null = null;
    if (typeof raw.sectionsUrl === "string") {
      if (!isAllowedOneNoteListUrl(raw.sectionsUrl)) return fresh;
      sectionsUrl = raw.sectionsUrl;
    }
    let pagesUrl: string | null = null;
    if (typeof raw.pagesUrl === "string") {
      if (!isAllowedOneNoteListUrl(raw.pagesUrl)) return fresh;
      pagesUrl = raw.pagesUrl;
    }
    if (pending.length === 0 && !sectionsUrl) return fresh;
    return { sectionsUrl, pending, pagesUrl: pending.length > 0 ? pagesUrl : null };
  } catch {
    return fresh;
  }
}

export function writeOneNoteCursor(
  resume: OneNoteResume,
  unsupported: UnsupportedOneNoteSection[] = []
): string {
  const payload = unsupported.length > 0 ? { ...resume, unsupported } : resume;
  return ONENOTE_CURSOR_PREFIX + JSON.stringify(payload);
}

export function readUnsupportedSections(
  cursor: string | null | undefined
): UnsupportedOneNoteSection[] {
  if (!cursor?.startsWith(ONENOTE_CURSOR_PREFIX)) return [];
  try {
    const raw = JSON.parse(cursor.slice(ONENOTE_CURSOR_PREFIX.length)) as { unsupported?: unknown };
    if (!Array.isArray(raw.unsupported)) return [];
    const byId = new Map<string, UnsupportedOneNoteSection>();
    for (const entry of raw.unsupported) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Partial<UnsupportedOneNoteSection>;
      if (typeof row.id !== "string" || !row.id) continue;
      const checkedAt =
        typeof row.checkedAt === "number" && Number.isFinite(row.checkedAt) ? row.checkedAt : 0;
      byId.set(row.id, {
        id: row.id,
        displayName: typeof row.displayName === "string" ? row.displayName : "",
        lastModified: typeof row.lastModified === "string" ? row.lastModified : null,
        checkedAt,
      });
    }
    return [...byId.values()];
  } catch {
    return [];
  }
}

/** Graph 422 / code 20258, or the stable message that goes with it. */
export function isUnsupportedSectionError(message: string): boolean {
  if (/sync of this section is not supported/i.test(message)) return true;
  return /["']code["']\s*:\s*["']?20258["']?/.test(message);
}

export interface OneNoteWalkResult {
  /** Set when the walk stopped early. Null after a finished pass. */
  resume: OneNoteResume | null;
  /** True when the time budget ended the walk and the caller should continue. */
  incomplete: boolean;
  /** Sections known to return 20258, including ones confirmed on this pass. */
  unsupported: UnsupportedOneNoteSection[];
}

function clip(message: string): string {
  return message.slice(0, 500);
}

function asCollection<T>(value: unknown): GraphCollection<T> | null {
  if (!value || typeof value !== "object") return null;
  return value as GraphCollection<T>;
}

function sectionRef(section: OneNoteSectionRow): OneNoteSectionRef | null {
  if (!section.id) return null;
  const ref: OneNoteSectionRef = {
    id: section.id,
    displayName: section.displayName || section.name || "",
  };
  if (section.lastModifiedDateTime) ref.lastModified = section.lastModifiedDateTime;
  return ref;
}

/**
 * Walks every section the user can access and every page inside it.
 * A failure while listing one section's pages is reported and the walk
 * continues with the next section. A failure while listing sections stops
 * this pass (the resume still points at that sections page) without throwing,
 * so the caller can keep going with other sources.
 */
export async function walkOneNote(
  resume: OneNoteResume,
  deps: {
    fetchJson: (url: string) => Promise<GraphCollection<OneNotePage | OneNoteSectionRow>>;
    onPage: (page: OneNotePage, section: OneNoteSectionRef) => Promise<void>;
    onError: (message: string) => void;
    outOfTime: () => boolean;
    /** Sections already known to return 20258. */
    unsupported?: UnsupportedOneNoteSection[];
    /** Counts a section that was skipped or confirmed unsupported. Not an error. */
    onUnsupportedSection?: (section: OneNoteSectionRef) => void;
    now?: () => number;
  }
): Promise<OneNoteWalkResult> {
  const state: OneNoteResume = {
    sectionsUrl: resume.sectionsUrl,
    pending: resume.pending.map((section) => ({ ...section })),
    pagesUrl: resume.pagesUrl,
  };
  let unsupported = (deps.unsupported ?? []).map((section) => ({ ...section }));
  const seenSectionLists = new Set<string>();
  const now = () => deps.now?.() ?? Date.now();
  const done = (resumePoint: OneNoteResume | null, incomplete: boolean): OneNoteWalkResult => ({
    resume: resumePoint,
    incomplete,
    unsupported,
  });
  const report = (message: string) => {
    const clipped = clip(message);
    console.error(`[onenote] ${clipped}`);
    deps.onError(clipped);
  };
  const rememberUnsupported = (section: OneNoteSectionRef) => {
    const entry: UnsupportedOneNoteSection = {
      id: section.id,
      displayName: section.displayName,
      lastModified: section.lastModified ?? null,
      checkedAt: now(),
    };
    const index = unsupported.findIndex((known) => known.id === section.id);
    if (index >= 0) unsupported[index] = entry;
    else unsupported.push(entry);
    console.info(
      `[onenote] Abschnitt nicht unterstützt (20258), übersprungen: ${section.displayName || section.id}`
    );
  };

  while (state.pending.length > 0 || state.sectionsUrl) {
    if (state.pending.length === 0 && state.sectionsUrl) {
      const sectionsUrl = state.sectionsUrl;
      if (seenSectionLists.has(sectionsUrl)) {
        report("OneNote: Abschnittsliste hat sich wiederholt, Paging gestoppt.");
        return done(state, false);
      }
      seenSectionLists.add(sectionsUrl);
      if (!isAllowedOneNoteListUrl(sectionsUrl)) {
        report("OneNote: Abschnittsliste hat eine unerwartete Adresse, Sync neu gestartet.");
        return done(null, false);
      }

      let collection: GraphCollection<OneNoteSectionRow> | null;
      try {
        collection = asCollection<OneNoteSectionRow>(await deps.fetchJson(sectionsUrl));
      } catch (err) {
        report(`OneNote: ${(err as Error).message}`);
        return done(state, false);
      }
      if (!collection) {
        report("OneNote: Abschnittsliste ohne verwertbare Antwort.");
        return done(state, false);
      }

      const next = collection["@odata.nextLink"];
      if (next && !isAllowedOneNoteListUrl(next)) {
        report("OneNote: Folgeseite der Abschnittsliste wird ignoriert.");
        state.sectionsUrl = null;
      } else {
        state.sectionsUrl = next ?? null;
      }
      state.pending = (Array.isArray(collection.value) ? collection.value : []).flatMap((section) => {
        const ref = sectionRef(section);
        return ref ? [ref] : [];
      });
      state.pagesUrl = null;
      if (deps.outOfTime()) return done(state, true);
      continue;
    }

    const section = state.pending[0];
    const known = unsupported.find((entry) => entry.id === section.id);
    if (known) {
      const modified =
        section.lastModified != null && section.lastModified !== known.lastModified;
      const due = modified || now() - known.checkedAt >= ONENOTE_UNSUPPORTED_RECHECK_MS;
      if (!due) {
        deps.onUnsupportedSection?.(section);
        state.pending.shift();
        state.pagesUrl = null;
        if (deps.outOfTime() && (state.pending.length > 0 || state.sectionsUrl)) {
          return done(state, true);
        }
        continue;
      }
      // Recheck from the first page. A stored pages URL belongs to a section
      // that was listing successfully, not to a 20258 section.
      state.pagesUrl = null;
    }

    let pagesUrl = state.pagesUrl || sectionPagesUrl(section.id);
    const seenPageLists = new Set<string>();

    while (pagesUrl) {
      if (seenPageLists.has(pagesUrl)) {
        report(`OneNote/${section.displayName || section.id}: Seitenliste hat sich wiederholt.`);
        break;
      }
      seenPageLists.add(pagesUrl);
      state.pagesUrl = pagesUrl;

      if (!isAllowedOneNoteListUrl(pagesUrl)) {
        report(
          `OneNote/${section.displayName || section.id}: Unerwartete Seitenadresse, Abschnitt übersprungen.`
        );
        break;
      }

      let collection: GraphCollection<OneNotePage> | null;
      try {
        collection = asCollection<OneNotePage>(await deps.fetchJson(pagesUrl));
      } catch (err) {
        const message = (err as Error).message;
        if (isUnsupportedSectionError(message)) {
          rememberUnsupported(section);
          deps.onUnsupportedSection?.(section);
          break;
        }
        report(`OneNote/${section.displayName || section.id}: ${message}`);
        break;
      }
      if (!collection) {
        report(`OneNote/${section.displayName || section.id}: Seitenliste ohne verwertbare Antwort.`);
        break;
      }
      if (known) unsupported = unsupported.filter((entry) => entry.id !== section.id);

      const pages = Array.isArray(collection.value) ? collection.value : [];
      for (const notePage of pages) {
        if (!notePage?.id) continue;
        if (deps.outOfTime()) {
          state.pagesUrl = pagesUrl;
          return done(state, true);
        }
        try {
          await deps.onPage(notePage, section);
        } catch (err) {
          deps.onError(clip(`${notePage.title || notePage.id}: ${(err as Error).message}`));
        }
        if (deps.outOfTime()) {
          state.pagesUrl = pagesUrl;
          return done(state, true);
        }
      }

      const next = collection["@odata.nextLink"];
      if (next && !isAllowedOneNoteListUrl(next)) {
        report(`OneNote/${section.displayName || section.id}: Folgeseite wird ignoriert.`);
        pagesUrl = "";
      } else {
        pagesUrl = next ?? "";
      }
      state.pagesUrl = pagesUrl || null;
      if (pagesUrl && deps.outOfTime()) return done(state, true);
    }

    state.pending.shift();
    state.pagesUrl = null;
    if (deps.outOfTime() && (state.pending.length > 0 || state.sectionsUrl)) {
      return done(state, true);
    }
  }

  return done(null, false);
}
