import { describe, it, expect } from 'vitest'
import { mapProduct, stockLabel, type ShopifyProductNode } from './products'
import { productToKnowledgeText } from './knowledge'

const ACCOUNT = '6d39a710-1014-48a3-80e5-3b0da26e6b7a'
const NOW = new Date('2026-11-03T00:00:00Z')

// Shapes taken from the live Shanthi Boutique catalogue.
const borderless: ShopifyProductNode = {
  id: 'gid://shopify/Product/8135495778383',
  legacyResourceId: '8135495778383',
  handle: 'border-less-saree-bl01',
  title: 'Border Less Saree | BL01',
  description: 'Experience pure comfort and modern elegance with this Borderless Saree.',
  productType: '',
  vendor: 'Shanthi Boutique',
  tags: [],
  status: 'ACTIVE',
  updatedAt: '2026-10-30T07:57:35Z',
  onlineStoreUrl: 'https://shanthiboutique.com/products/border-less-saree-bl01',
  tracksInventory: true,
  totalInventory: 30,
  featuredMedia: {
    preview: { image: { url: 'https://cdn.shopify.com/s/files/1/0678/7137/5439/files/border_less_saree_violet1.jpg?v=1772284713' } },
  },
  priceRangeV2: {
    minVariantPrice: { amount: '899.0', currencyCode: 'INR' },
    maxVariantPrice: { amount: '899.0' },
  },
  variants: {
    edges: [
      { node: { id: 'gid://shopify/ProductVariant/1', title: 'Blue', sku: null, price: '899.00', inventoryQuantity: 5, availableForSale: true } },
      { node: { id: 'gid://shopify/ProductVariant/2', title: 'Black', sku: null, price: '899.00', inventoryQuantity: 0, availableForSale: false } },
    ],
  },
}

const kdKolam: ShopifyProductNode = {
  id: 'gid://shopify/Product/15508433862735',
  legacyResourceId: '15508433862735',
  handle: 'kd-kolam-4',
  title: 'Kd kolam',
  description: '',
  productType: 'Customer request',
  vendor: 'Shanthi Boutique',
  tags: ['Customer request'],
  status: 'ACTIVE',
  updatedAt: '2026-11-02T23:51:46Z',
  onlineStoreUrl: null,
  tracksInventory: false,
  totalInventory: 0,
  featuredMedia: null,
  priceRangeV2: {
    minVariantPrice: { amount: '799.0', currencyCode: 'INR' },
    maxVariantPrice: { amount: '799.0' },
  },
  variants: {
    edges: [
      { node: { id: 'gid://shopify/ProductVariant/3', title: 'Default Title', sku: null, price: '799.00', inventoryQuantity: -1, availableForSale: true } },
    ],
  },
}

describe('mapProduct', () => {
  it('maps a tracked, published product', () => {
    const row = mapProduct(borderless, ACCOUNT, 'https://shanthiboutique.com', NOW)
    expect(row).toMatchObject({
      account_id: ACCOUNT,
      shopify_product_id: 8135495778383,
      title: 'Border Less Saree | BL01',
      status: 'active',
      price_min: 899,
      price_max: 899,
      currency: 'INR',
      total_inventory: 30,
      tracks_inventory: true,
      online_url: 'https://shanthiboutique.com/products/border-less-saree-bl01',
      synced_at: NOW.toISOString(),
    })
    expect(row.image_url).toContain('border_less_saree_violet1.jpg')
    expect(row.variants).toHaveLength(2)
    expect(row.variants[1]).toMatchObject({ title: 'Black', available: false, inventory: 0 })
  })

  it('falls back to the storefront URL when the product is not on the online store', () => {
    const row = mapProduct(kdKolam, ACCOUNT, 'https://shanthiboutique.com/', NOW)
    expect(row.online_url).toBe('https://shanthiboutique.com/products/kd-kolam-4')
    expect(row.image_url).toBeNull()
    expect(row.product_type).toBe('Customer request')
  })
})

describe('stockLabel', () => {
  it('treats untracked products as in stock and tracked zero as out', () => {
    expect(stockLabel({ tracks_inventory: false, total_inventory: 0 })).toBe('in_stock')
    expect(stockLabel({ tracks_inventory: true, total_inventory: 0 })).toBe('out_of_stock')
    expect(stockLabel({ tracks_inventory: true, total_inventory: 3 })).toBe('in_stock')
  })
})

describe('productToKnowledgeText', () => {
  it('includes price, stock, options and link for the AI', () => {
    const text = productToKnowledgeText(mapProduct(borderless, ACCOUNT, null, NOW))
    expect(text).toContain('Product: Border Less Saree | BL01')
    expect(text).toContain('₹899')
    expect(text).toContain('In stock (30 available)')
    expect(text).toContain('Options: Blue, Black (sold out)')
    expect(text).toContain('Link: https://shanthiboutique.com/products/border-less-saree-bl01')
  })

  it('omits the placeholder Default Title variant', () => {
    const text = productToKnowledgeText(mapProduct(kdKolam, ACCOUNT, 'https://shanthiboutique.com', NOW))
    expect(text).toContain('Price: ₹799')
    expect(text).not.toContain('Default Title')
  })
})
