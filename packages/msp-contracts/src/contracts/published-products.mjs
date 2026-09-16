import { ValidationError, GksProviderInvalidResponseError } from './errors.mjs';

const id = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256;
const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function validateProductQueryRequest(args, sameScope) {
  const c = args.corpusContext;
  const invalid = () => { throw new ValidationError('pipeline_invalid_product_query'); };
  if (args.productSchemaVersion !== 'published-products.v1' || !['search', 'price', 'budget'].includes(args.operation) ||
      c?.schemaVersion !== 'edge-published-corpus.v1' || !sameScope(c.scope, args.scope) || !id(c.corpusId) ||
      !Number.isSafeInteger(c.corpusGeneration) || c.corpusGeneration < 0 || !hash(c.manifestHash) ||
      !Number.isFinite(Date.parse(c.expiresAt)) || Date.parse(c.expiresAt) <= Date.now() || Date.parse(c.expiresAt) > Date.now() + 60000 ||
      !Array.isArray(c.entries) || c.entries.length > 2048) invalid();
  const sources = new Set();
  for (const e of c.entries) {
    if (!e || ['sourceId', 'snapshotId', 'generation', 'rawArtifactId', 'parsedArtifactId'].some((k) => !id(e[k])) || !hash(e.receiptHash) || sources.has(e.sourceId)) invalid();
    sources.add(e.sourceId);
  }
  if (!Number.isSafeInteger(args.topK ?? 5) || (args.topK ?? 5) < 1 || (args.topK ?? 5) > 20 ||
      (args.quantity !== undefined && args.quantity !== null && (!Number.isSafeInteger(args.quantity) || args.quantity < 1))) invalid();
  if (args.operation === 'search' && (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 16000)) invalid();
  if (args.operation === 'price' && !id(args.code)) invalid();
  if (args.operation === 'budget' && (!Number.isSafeInteger(args.quantity) || args.quantity < 1 || !Number.isFinite(args.maxPriceThb) || args.maxPriceThb < 0 || !Number.isSafeInteger(Math.floor(args.maxPriceThb * 100)))) invalid();
  if (Buffer.byteLength(JSON.stringify(c), 'utf8') > 1024 * 1024 || Buffer.byteLength(JSON.stringify(args), 'utf8') > 1024 * 1024 + 65536) invalid();
}

export function validateProductQueryResponse(result, request) {
  const invalid = () => { throw new GksProviderInvalidResponseError('pipeline_invalid_product_response'); };
  const c = request.corpusContext;
  if (result.productSchemaVersion !== 'published-products.v1' || result.operation !== request.operation ||
      result.corpusId !== c.corpusId || result.corpusGeneration !== c.corpusGeneration || result.manifestHash !== c.manifestHash ||
      !Array.isArray(result.results) || result.results.length > (request.topK ?? 5) ||
      result.priceBasis !== 'PUBLISHED_CATALOG_SNAPSHOT_NOT_LIVE_QUOTE' ||
      !Number.isSafeInteger(result.lanes?.graphCalls) || result.lanes.graphCalls < 0 ||
      !Number.isSafeInteger(result.lanes?.vectorCalls) || result.lanes.vectorCalls < 0) invalid();
  const entries = new Map(c.entries.map((e) => [e.sourceId, e]));
  const citation = (ref) => {
    const e = entries.get(ref?.sourceId);
    if (!e || ['snapshotId', 'generation', 'rawArtifactId', 'parsedArtifactId'].some((k) => ref[k] !== e[k]) || !id(ref.chunkId) || !hash(ref.contentHash)) invalid();
  };
  const graph = (g) => {
    if (!g || !['PRICED_AT', 'HAS_COMPONENT', 'IN_CATEGORY'].includes(g.predicate) ||
        ['entityId', 'targetEntityId', 'targetCode', 'factId'].some((k) => !id(g[k])) || !Array.isArray(g.path) || g.path.length !== 1 ||
        !id(g.path[0].id) || !id(g.path[0].from) || !id(g.path[0].to) || g.path[0].rel !== g.predicate) invalid();
    citation(g.citation);
  };
  const price = (p) => {
    if (!id(p?.code) || !Array.isArray(p.tiers) || p.tiers.length > 128 || !['PRICE_MISSING', 'BELOW_MOQ', 'CATALOG_SNAPSHOT'].includes(p.status)) invalid();
    const quantities = new Set();
    for (const t of p.tiers) {
      if (!Number.isSafeInteger(t.minQty) || t.minQty < 1 || !Number.isSafeInteger(t.amountMinor) || t.amountMinor < 0 || t.currency !== 'THB' ||
          t.status !== 'CATALOG_SNAPSHOT' || t.unit !== null || t.validFrom !== null || t.validUntil !== null || t.taxBasis !== null || t.shippingBasis !== null ||
          !(t.asOf === null || /^\d{4}-\d{2}-\d{2}$/.test(t.asOf))) invalid();
      if (quantities.has(t.minQty) || t.graph?.predicate !== 'PRICED_AT') invalid();
      quantities.add(t.minQty);
      citation(t.citation); graph(t.graph);
    }
    if (p.selected !== null && !p.tiers.some((t) => JSON.stringify(t) === JSON.stringify(p.selected))) invalid();
    const eligible = p.tiers.filter((t) => request.quantity && t.minQty <= request.quantity).sort((a, b) => a.minQty - b.minQty);
    if (JSON.stringify(p.selected) !== JSON.stringify(eligible.at(-1) ?? null)) invalid();
    const status = !p.tiers.length ? 'PRICE_MISSING' : request.quantity && !eligible.length ? 'BELOW_MOQ' : 'CATALOG_SNAPSHOT';
    if (p.status !== status) invalid();
  };
  for (const p of result.results) {
    if (!id(p.code) || typeof p.name !== 'string' || !Number.isFinite(p.score) || !['PRODUCT', 'PACKAGE'].includes(p.kind) || !Array.isArray(p.graph) || p.graph.length > 128) invalid();
    citation(p.citation); p.graph.forEach(graph); price(p.price);
    if (p.price.code !== p.code || (request.operation === 'budget' && (!p.price.selected || p.price.selected.amountMinor > Math.floor(request.maxPriceThb * 100)))) invalid();
  }
  if (request.operation === 'price') { price(result.price); if (result.price.code !== request.code) invalid(); }
}
