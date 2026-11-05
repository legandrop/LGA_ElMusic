export interface RecommendationSeed { title: string; artist: string; album: string; country: string }
export type RecommendationMode = 'track' | 'artist';
export const recommendationLimits = { candidates: 48, verified: 32, queue: 24 } as const;
export interface RecommendationMatchDiagnostic {
  candidateIndex: number; hasMbid: boolean; durationSource: 0 | 1; mbDurationMs?: number;
  rowCount: number; exactRowCount: number; versionSafeRowCount: number; durationRowCount: number;
  minAppleDurationMs?: number; maxAppleDurationMs?: number;
  status: 0 | 1 | 2; // missing, ambiguous, matched por selector; no acredita SongDetail ni audio.
  selectionPolicy: 0 | 1; // Recording conservador o catálogo normal Last.fm.
}
export interface RecommendationDiagnostic {
  provider: 'MusicBrainz' | 'ListenBrainz' | 'iTunes' | 'Apple Music';
  stage: 'semilla-grabacion' | 'semilla-artista' | 'identidad-artista' | 'pagina-artista' | 'album-semilla' |
    'similares-grabaciones' | 'similares-artistas' | 'busqueda-canciones' | 'duraciones' | 'pagina-cancion';
  httpStatus?: number;
  failure: 'ninguno' | 'red' | 'tiempo-agotado' | 'http' | 'limite' | 'datos-invalidos' | 'validacion' | 'desconocido';
  attempt: 1 | 2;
  outcome: 'respuesta' | 'fallo' | 'reintento';
}
export interface RecommendationCandidate {
  title: string; artist: string; album?: string; durationMs?: number;
  recordingMbid?: string; artistMbid?: string;
  source: 'ListenBrainz' | 'Last.fm' | 'Apple Music'; signal: RecommendationMode; rank: number;
  sourceUrl: string; algorithm: string;
}
export interface Recommendation {
  id: string; url: string; title: string; artist: string; album: string;
  artworkUrl?: string;
  source: 'ListenBrainz' | 'Last.fm' | 'Apple Music'; signal: RecommendationMode; sourceUrl: string;
  matchMethod: 'metadata' | 'public-catalog'; recordingIdentityVerified: false;
  editionStatus: 'single' | 'compatible-editions'; alternativeIds: string[];
  candidateKey?: string; albumId?: string; albumUrl?: string; artistId?: string; artistUrl?: string;
}
export interface RecommendationCard {
  key: string; title: string; artist: string; album?: string; artworkUrl?: string;
  source: RecommendationCandidate['source']; signal: RecommendationMode; sourceUrl: string;
  verificationStatus: 'pending' | 'checking' | 'verified' | 'unavailable'; verifiedId?: string;
  reason?: 'missing' | 'ambiguous' | 'provider-unavailable' | 'limit' | 'duplicate';
}
export interface RecommendationResult {
  items: Recommendation[]; experimental: boolean; partial: boolean;
  lastFmConfigured: boolean; artistFallback: boolean;
  rejected: number; unresolved: number; providerUnavailable: boolean;
  emptyReason?: 'unresolved-seed' | 'no-candidates' | 'no-apple-matches';
  cards?: RecommendationCard[];
}
export interface LastFmCandidates {
  candidates: RecommendationCandidate[]; configured: boolean; unavailable: boolean;
  cacheForMs: number;
}
