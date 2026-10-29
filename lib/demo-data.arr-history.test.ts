import { getDemoResponse } from "@/lib/demo-data";
import { normalizeRadarrHistory, normalizeSonarrHistory } from "@/lib/arr-history";
import type {
  RadarrHistory,
  RadarrHistoryRecord,
  SonarrHistory,
} from "@/lib/types";

/**
 * The *arr history fixtures are polled every few seconds by the poster map and
 * the grab/import notification watchers, so a missing route errors on every
 * poll. These pin the shapes the API modules expect and push the records
 * through the real normalizers.
 */

describe("Radarr", () => {
  it("answers the global /history with a page of records, newest first", () => {
    const page = getDemoResponse("radarr", "/history", { page: 1, pageSize: 50 }) as RadarrHistory;
    expect(page.totalRecords).toBe(page.records.length);
    expect(page.records.length).toBeGreaterThan(0);
    const dates = page.records.map((r) => Date.parse(r.date!));
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    for (const record of page.records) {
      expect(record.movie?.id).toBe(record.movieId);
      expect(normalizeRadarrHistory(record).title).toBe(record.sourceTitle);
    }
  });

  it("answers /history/movie with a plain array for that movie only", () => {
    const records = getDemoResponse("radarr", "/history/movie", { movieId: 1 }) as RadarrHistoryRecord[];
    expect(Array.isArray(records)).toBe(true);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.movieId === 1)).toBe(true);
    expect(getDemoResponse("radarr", "/history/movie", { movieId: 999 })).toEqual([]);
  });
});

describe("Sonarr", () => {
  it("answers the global /history with a page of records, newest first", () => {
    const page = getDemoResponse("sonarr", "/history", { page: 1, pageSize: 50 }) as SonarrHistory;
    expect(page.totalRecords).toBe(page.records.length);
    expect(page.records.length).toBeGreaterThan(0);
    const dates = page.records.map((r) => Date.parse(r.date!));
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    for (const record of page.records) {
      expect(record.series?.id).toBe(record.seriesId);
      expect(record.episode?.id).toBe(record.episodeId);
      expect(normalizeSonarrHistory(record).title).toBe(record.sourceTitle);
    }
  });

  it("filters /history by episodeId for the per-episode screen", () => {
    const page = getDemoResponse("sonarr", "/history", { episodeId: 1206, page: 1, pageSize: 100 }) as SonarrHistory;
    expect(page.records.length).toBeGreaterThan(0);
    expect(page.records.every((r) => r.episodeId === 1206)).toBe(true);
    expect(page.totalRecords).toBe(page.records.length);
    const none = getDemoResponse("sonarr", "/history", { episodeId: 999999 }) as SonarrHistory;
    expect(none.records).toEqual([]);
  });
});
