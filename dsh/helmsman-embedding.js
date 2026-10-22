// [helmsman] D3-8 local vector embeddings (migrated from server-ts/embedding.ts).
// transformers.js + bge-small-zh-v1.5 (512-dim ONNX, ~95MB):
//   - Lazy loading: the model is only loaded on the first embed (HF cache defaults to ~/.cache/huggingface, override with HF_HOME)
//   - Degradation: model load/inference failure → null, and the caller falls back to rule-based retrieval (nothing breaks)
//   - bge retrieval prefix: an instruction prefix on the query side only (not on documents), for Chinese queries
// Pure-function module: registers no plugin service; helmsman-kb imports it statically.
import { pipeline } from '@huggingface/transformers'

const MODEL = 'Xenova/bge-small-zh-v1.5'
/** bge retrieval instruction prefix (query side only; not added to documents). Chinese queries get the Chinese instruction (measurably better). This string is model input for the Chinese bge model and intentionally stays in Chinese; it means "Generate a representation for this sentence for retrieving related articles:". */
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'

let pipe = null
let loading = null

/** Lazily load the embedder; returns null on failure (does not throw, so callers can degrade). */
export async function getEmbedder() {
  if (pipe) return pipe
  if (loading) return loading
  loading = (async () => {
    try {
      pipe = await pipeline('feature-extraction', MODEL)
      return pipe
    } catch (e) {
      console.error(`[helmsman-embedding] model failed to load (${MODEL}); retrieval falls back to the rule channel:`, e?.message ?? e)
      pipe = null
      return null
    }
  })()
  return loading
}

/**
 * Batch-embed texts (mean pooling + L2 normalization).
 * @returns one vector per text; null when the embedder is unavailable
 */
export async function embedTexts(texts, opts = {}) {
  const p = await getEmbedder()
  if (!p) return null
  if (!texts || texts.length === 0) return []
  const mapped = opts.query
    ? texts.map((t) => (/[\u4e00-\u9fa5]/.test(t ?? '') ? QUERY_PREFIX : '') + (t ?? ''))
    : texts.map((t) => t ?? '')
  const out = await p(mapped, { pooling: 'mean', normalize: true })
  // With multiple inputs transformers.js may return an array of Tensors (one each) or a single batch Tensor [n, dim]
  if (Array.isArray(out)) {
    return out.map((r) => Float32Array.from(r?.data ?? []))
  }
  const t = out ?? {}
  const data = t.data
  if (!data) return null
  if (texts.length === 1 || data.length === texts.length) return [Float32Array.from(data)]
  const per = Math.floor(data.length / texts.length)
  const rows = []
  for (let i = 0; i < texts.length; i++) rows.push(Float32Array.from(data.subarray(i * per, (i + 1) * per)))
  return rows
}

/** Cosine similarity (equivalent to a dot product for normalized vectors; still normalizes explicitly in case inputs are not). */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/** Note vector cache (invalidated by id + updatedAt; assembly is on the task-start path, so avoid recomputing everything each time). */
const noteVecCache = new Map()

function noteEmbedText(n) {
  return `${n.title ?? ''}\n${n.summary ?? ''}\n${(n.content ?? []).join('\n').slice(0, 2000)}`
}

/**
 * Batch-embed notes (cached): only compute for notes that are uncached or changed; reuse the rest.
 * @returns an array of vectors the same length as notes; null when the embedder is unavailable
 */
export async function embedNotes(notes) {
  const p = await getEmbedder()
  if (!p) return null
  if (!notes || notes.length === 0) return []
  const out = new Array(notes.length)
  const miss = []
  notes.forEach((n, i) => {
    const hit = noteVecCache.get(n.id)
    if (hit && hit.updatedAt === (n.updatedAt ?? 0)) out[i] = hit.vec
    else miss.push(i)
  })
  if (miss.length > 0) {
    const vecs = await embedTexts(miss.map((i) => noteEmbedText(notes[i])))
    if (!vecs) return null
    miss.forEach((i, k) => {
      const v = vecs[k]
      noteVecCache.set(notes[i].id, { updatedAt: notes[i].updatedAt ?? 0, vec: v })
      out[i] = v
    })
  }
  return out
}
