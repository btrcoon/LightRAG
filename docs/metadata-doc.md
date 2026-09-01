# Metadata Support and Filtering in LightRAG

LightRAG supports replacing components at several boundaries, but metadata is a cross-cutting policy that is not currently pluggable end to end.

Choose the design based on what the metadata needs to do:

- **Tenant, project, or ACL isolation:** Use the existing workspace partitioning. It is simpler, faster, and safer than metadata filtering.
- **Tags, dates, or categories:** Store metadata once per document and join it through the existing `full_doc_id`.
- **Highly selective filtering at high query volume:** Add optional native filtering to vector backends later.
- **Instructions for the answering LLM:** Use `QueryParam.user_prompt`. Retrieval filtering is unnecessary in this case.

## Current architecture

```text
insert
  → apipeline_enqueue_documents
  → full_docs + doc_status
  → parser
  → chunker
  → text_chunks + chunks_vdb
  → entity/relation extraction
  → graph + entity/relation vectors

query
  → QueryParam
  → kg_query / naive_query
  → vector search
  → graph/KV expansion
  → merge/rerank/truncate
  → fixed response projection
  → LLM prompt
```

## Extensibility assessment

| Area | Assessment | Evidence |
| --- | --- | --- |
| LLM, embeddings, and reranker | Strong | Injectable callables and role-specific configuration |
| Parsers | Strong | `BaseParser`, a registry, lazy loading, and third-party entry points in `lightrag/parser/plugins.py:1-65` |
| Chunking | Medium | Custom synchronous or asynchronous `chunking_func`, but it has a legacy six-argument signature and no document context |
| Storage | Medium | Good abstract base classes and a central factory, but implementation lists are static in `lightrag/kg/__init__.py:1-172` |
| Pipeline | Weak to medium | Internally divided into mixins, but `LightRAG` is `@final` and has no public enrichment or lifecycle hooks |
| Query policy | Weak | Fixed function signatures and result projections implement retrieval |
| Metadata filtering | Poor | No ingestion contract, filter model, storage filter contract, or propagation to prompts and results |

In short, LightRAG is component-pluggable but not policy-pluggable.

## Existing metadata support

### Document status metadata

`DocProcessingStatus` already includes:

```python
metadata: dict[str, Any]
```

See `lightrag/base.py:1019-1095`.

This dictionary primarily stores internal processing and recovery state. State transitions rebuild it from allowlists:

- `doc_status_metadata_carry_over`: `lightrag/utils_pipeline.py:540-559`
- `doc_status_transition_metadata`: `lightrag/utils_pipeline.py:562-586`
- `doc_status_reset_metadata`: `lightrag/utils_pipeline.py:657-684`

Arbitrary fields added to `doc_status.metadata` can therefore disappear during parsing, processing, failure, or retry.

The REST status response already exposes metadata and includes an author-and-year example in `lightrag/api/routers/document_routes.py:1101-1153`, but ingestion cannot currently supply that metadata.

### Chunk metadata

`build_chunks_dict_from_chunking_result()` preserves almost every field returned by a chunker:

```python
stored_chunk = {k: v for k, v in dp.items() if k != "_source_span"}
```

See `lightrag/utils_pipeline.py:144-201`.

This metadata does not remain portable through the full pipeline:

- Chunk vectors retain only `full_doc_id`, `content`, and `file_path`: `lightrag/lightrag.py:1471-1476`.
- PostgreSQL text-chunk serialization uses a fixed schema.
- `_get_vector_context()` discards extra vector payload fields: `lightrag/operate.py:5027-5081`.
- `_merge_all_chunks()` narrows the fields again: `lightrag/operate.py:5520-5625`.
- Public query results retain only content, path, ID, and reference: `lightrag/utils.py:6747-6868`.
- Prompt rendering retains only content, reference ID, and optional headings: `lightrag/utils.py:6937-6958`.

### Query metadata

`QueryParam` has no metadata filter, document IDs, tags, or source predicates (`lightrag/base.py:90-164`). `BaseVectorStorage.query()` also has no filter parameter (`lightrag/base.py:278-289`).

The REST `QueryRequest` has the same limitation in `lightrag/api/routers/query_routes.py:29-233`.

## Recommended implementation

### 1. Store document metadata in one place

Persist user-supplied metadata under a reserved nested key:

```python
doc_status.metadata = {
    # Existing internal keys
    "user_metadata": {
        "tenant": "acme",
        "category": "legal",
        "year": 2025,
        "tags": ["contract", "eu"],
    },
}
```

This location has several advantages:

- Current document-status backends already support an opaque object or JSON value.
- PostgreSQL uses JSONB.
- No new table or vector schema is required.
- Metadata is stored once per document instead of being copied into every chunk.
- Every chunk already has `full_doc_id`, which provides the join.

Add `"user_metadata"` to both `_DOC_STATUS_METADATA_CARRY_OVER_KEYS` and `_DOC_STATUS_METADATA_DIRECTIVE_KEYS`. This preserves it through normal state transitions and `FAILED` to `PENDING` retries without exposing internal metadata keys to callers.

Expose a separate API field named `document_metadata`. Do not let callers write arbitrary keys directly into the internal metadata dictionary.

### 2. Add ingestion parameters

Proposed SDK interface:

```python
await rag.ainsert(
    documents,
    document_metadata=[
        {"tenant": "acme", "year": 2025},
        {"tenant": "acme", "year": 2024},
    ],
)
```

Core changes would affect:

- `lightrag/lightrag.py:1736-1841`
- `lightrag/pipeline.py:664-1568`
- `lightrag/utils_pipeline.py:374-684`

REST changes would include:

- `document_metadata` on `InsertTextRequest`;
- aligned `document_metadatas` on `InsertTextsRequest`;
- a validated metadata JSON form field on the upload endpoint; and
- propagation through `pipeline_index_texts()`.

Relevant REST code is in `lightrag/api/routers/document_routes.py:806-924` and `lightrag/api/routers/document_routes.py:2777-2830`.

### 3. Add one hook for metadata computed during processing

Do not change every parser or the legacy chunker signature. Add one optional callable to `LightRAG`, for example:

```python
document_metadata_func: Callable[
    [DocumentMetadataContext],
    Awaitable[Mapping[str, JSONValue]],
] | None
```

Call it once after parsing and analysis but before chunk persistence in `process_single_document()` (`lightrag/pipeline.py:4755-5404`).

The context should contain:

- `doc_id`;
- `file_path`;
- the parsed content or result; and
- the current user metadata.

Merge the returned values into `user_metadata`. Update both persisted metadata and the in-memory `status_doc`; otherwise, the next state transition could overwrite the new values.

When metadata can be calculated before insertion, calculate it outside LightRAG instead. That remains simpler and avoids an extra processing hook.

### 4. Start with a small filter language

Support flat equality and `IN` semantics:

```python
QueryParam(
    mode="naive",
    metadata_filter={
        "tenant": "acme",
        "year": [2024, 2025],
    },
    include_document_metadata=True,
)
```

Use these rules:

- Combine keys with `AND`.
- Treat a scalar as equality.
- Treat a list as membership or `IN`.
- Treat a missing field as no match.
- Accept only JSON-compatible values.

Do not expose raw PostgreSQL, Qdrant, MongoDB, or OpenSearch expressions. Doing so would tie the public API to individual backends and introduce injection and compatibility risks.

### 5. Implement portable post-filtering first

Use this retrieval flow to avoid initial backend migrations:

1. Retrieve an oversized set of vector candidates.
2. Preserve `full_doc_id` from each vector result.
3. Batch-load metadata for the unique document IDs.
4. Filter the candidates.
5. Rerank and truncate the remaining candidates.
6. Return the requested top K.

Add a non-abstract document-status method such as:

```python
async def get_document_metadata_by_ids(
    self,
    doc_ids: Sequence[str],
    *,
    strict: bool = False,
) -> dict[str, dict[str, JSONValue]]:
    ...
```

The default implementation can use `get_full_docs_by_ids()`. PostgreSQL, MongoDB, and OpenSearch can later override it with projections that fetch only the ID and metadata.

This design keeps one metadata copy per document and uses one batch read instead of N point reads.

For filters with reasonable selectivity, start with:

```text
candidate_k = min(chunk_top_k × 4, configured_cap)
```

Filter before reranking so excluded documents do not consume reranker calls.

### 6. Add optional native filtering later

For highly selective filters or high query volume, add an optional capability instead of changing the existing abstract `query()` signature:

```python
supports_metadata_filter: bool = False

async def query_with_filter(...):
    ...
```

Backends that support server-side filtering can implement it. Existing and third-party backends can continue using the post-filter fallback.

Native filtering requires copying an allowlisted subset of metadata into vector payloads and applying backend-specific migrations:

- **Qdrant, MongoDB, and OpenSearch:** Filtering fits their existing models relatively naturally.
- **PostgreSQL:** Add a JSONB column and index.
- **Milvus:** Add an explicit JSON or scalar schema.
- **FAISS and Nano:** Filter in process.

Index only configured keys such as `tenant`, `category`, and `year`. Indexing arbitrary metadata risks mapping explosion and storage amplification.

## Query results and prompts

Keep these concepts separate:

1. **Document metadata:** Stored attributes of a source document.
2. **Metadata filter:** Retrieval criteria that affect cache identity.
3. **Request metadata:** Request, user, or trace context that does not affect retrieval.

Return document metadata in each structured result:

```json
{
  "chunk_id": "...",
  "full_doc_id": "...",
  "content": "...",
  "document_metadata": {
    "tenant": "acme",
    "year": 2025
  }
}
```

Do not add document metadata to the existing top-level `metadata` field. That field currently describes the query mode, keywords, and processing counts.

Do not inject document metadata into LLM context by default. If prompt access is needed, require an explicit allowlist because arbitrary metadata can contain secrets or prompt-injection text.

## Knowledge graph limitation

In `local`, `global`, `hybrid`, and `mix` modes, LightRAG merges entities and relationships across source chunks. Filtering only the final chunks does not remove information already incorporated into merged entity or relationship descriptions.

For the initial implementation:

- Support strict filtering in `naive` mode.
- Reject filters in knowledge graph modes or label them explicitly as chunk-only.
- Use separate workspace values for tenant, ACL, or other security boundaries.
- Treat fully filtered knowledge graph retrieval as a larger redesign requiring partitioned graphs or per-source graph fragments.

A metadata filter over the current shared graph must not be presented as an authorization boundary.

## Cache correctness

Both knowledge graph and naive answer-cache hashes enumerate `QueryParam` fields explicitly:

- `lightrag/operate.py:4682-4700`
- `lightrag/operate.py:6696-6715`

Include a normalized metadata filter in the cache hash and increment the cache-policy version. For ACL-sensitive metadata, either disable answer caching or include a metadata or corpus revision. Otherwise, a cached answer authorized before a metadata change could remain accessible afterward.

## Recommended approach by use case

| Requirement | Best approach |
| --- | --- |
| Tenant or project isolation | Existing workspace partitioning |
| Instructions for the answering LLM | `QueryParam.user_prompt` |
| Prototype tags without core changes | External side index plus `aquery_data()` over-fetching |
| Portable first-class tag filtering | Document metadata in `doc_status` plus batch post-filtering |
| Highly selective production filtering | Optional native vector-backend capability |
| Strict filtering of knowledge graph facts | Separate workspaces or graphs |

## First milestone

Start with:

- namespaced document metadata;
- equality and `IN` filters;
- post-filtering in `naive` mode;
- optional metadata in structured results; and
- no backend schema migrations.

This milestone minimizes complexity and preserves backward compatibility while leaving a clear path to native filtering later.
