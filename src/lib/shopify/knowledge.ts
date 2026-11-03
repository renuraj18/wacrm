import type { SupabaseClient } from '@supabase/supabase-js'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { formatPriceRange } from '@/lib/products/format'
import { stockLabel, type ProductRow } from './products'

// ============================================================
// Products as AI knowledge. Each product is one
// `ai_knowledge_documents` row (source = 'shopify', product_id set),
// chunked and retrieved by the existing knowledge-base code, so AI
// drafts and auto-replies can quote prices, stock and links.
// ============================================================

/** Plain-text knowledge entry for one product. */
export function productToKnowledgeText(p: ProductRow): string {
  const lines = [`Product: ${p.title}`]
  if (p.product_type) lines.push(`Type: ${p.product_type}`)
  lines.push(`Price: ${formatPriceRange(p)}`)
  const stock = stockLabel(p)
  if (stock === 'out_of_stock') {
    lines.push('Availability: Out of stock')
  } else if (p.tracks_inventory && p.total_inventory != null) {
    lines.push(`Availability: In stock (${p.total_inventory} available)`)
  } else {
    lines.push('Availability: In stock')
  }
  const options = p.variants
    .filter((v) => v.title && v.title !== 'Default Title')
    .map((v) => (v.available ? v.title : `${v.title} (sold out)`))
  if (options.length) lines.push(`Options: ${options.join(', ')}`)
  if (p.tags.length) lines.push(`Tags: ${p.tags.join(', ')}`)
  if (p.online_url) lines.push(`Link: ${p.online_url}`)
  if (p.description) lines.push('', p.description)
  return lines.join('\n')
}

/**
 * Upsert + (re)index knowledge documents for these products. `rows`
 * pairs each product row with its `products.id`. Failures are logged
 * per product and never abort the batch — the catalogue sync itself
 * must not fail because an embeddings call did.
 */
export async function syncProductKnowledge(
  db: SupabaseClient,
  accountId: string,
  rows: { productId: string; row: ProductRow }[],
): Promise<void> {
  if (rows.length === 0) return
  const { key: embeddingsApiKey } = await loadEmbeddingsKey(db, accountId)

  for (const { productId, row } of rows) {
    try {
      const content = productToKnowledgeText(row)
      const { data, error } = await db
        .from('ai_knowledge_documents')
        .upsert(
          {
            account_id: accountId,
            product_id: productId,
            source: 'shopify',
            title: row.title,
            content,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'product_id' },
        )
        .select('id')
        .single()
      if (error || !data) throw error ?? new Error('no document id')
      await ingestDocument(db, accountId, { embeddingsApiKey }, data.id as string, content)
    } catch (err) {
      console.error(`[shopify] knowledge sync failed for product ${row.shopify_product_id}:`, err)
    }
  }
}

/** Drop every Shopify-sourced knowledge document for the account. */
export async function clearProductKnowledge(db: SupabaseClient, accountId: string): Promise<void> {
  const { error } = await db
    .from('ai_knowledge_documents')
    .delete()
    .eq('account_id', accountId)
    .eq('source', 'shopify')
  if (error) throw error
}
