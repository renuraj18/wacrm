"use client";

// ============================================================
// Products — the account's synced Shopify catalogue.
//
// Search + product-type filter over /api/products, paged with
// "Load more". Read-only: products are edited in Shopify and arrive
// here through the sync / webhooks (Settings → Shopify).
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ExternalLink, ImageOff, Loader2, Search, ShoppingBag } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  formatPriceRange,
  isInStock,
  type ProductListItem,
} from "@/lib/products/format";

const PAGE_SIZE = 24;

interface ProductsResponse {
  products: ProductListItem[];
  total: number;
  types?: string[];
}

export default function ProductsPage() {
  const t = useTranslations("Products");
  const [products, setProducts] = useState<ProductListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [types, setTypes] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestId = useRef(0);

  const fetchPage = useCallback(
    async (offset: number): Promise<ProductsResponse | null> => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (query.trim()) params.set("q", query.trim());
      if (type) params.set("type", type);
      const res = await fetch(`/api/products?${params}`, { cache: "no-store" });
      if (!res.ok) return null;
      return (await res.json()) as ProductsResponse;
    },
    [query, type],
  );

  // Debounced reload whenever search or filter changes.
  useEffect(() => {
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      const data = await fetchPage(0);
      if (id !== requestId.current) return;
      setProducts(data?.products ?? []);
      setTotal(data?.total ?? 0);
      if (data?.types) setTypes(data.types);
      setLoading(false);
    }, 250);
    return () => clearTimeout(timer);
  }, [fetchPage]);

  async function loadMore() {
    setLoadingMore(true);
    const data = await fetchPage(products.length);
    if (data) setProducts((prev) => [...prev, ...data.products]);
    setLoadingMore(false);
  }

  const noCatalogue = !loading && total === 0 && !query && !type;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {noCatalogue ? t("subtitleEmpty") : t("subtitle", { count: total })}
          </p>
        </div>
      </div>

      {!noCatalogue ? (
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="pl-9"
            />
          </div>
          {types.length > 0 ? (
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
              aria-label={t("typeFilter")}
            >
              <option value="">{t("allTypes")}</option>
              {types.map((ty) => (
                <option key={ty} value={ty}>
                  {ty}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : noCatalogue ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12 text-center">
            <ShoppingBag className="size-8 text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">{t("empty")}</p>
            <Link href="/settings?tab=shopify" className={buttonVariants({ className: "mt-4" })}>
              {t("connectShopify")}
            </Link>
          </CardContent>
        </Card>
      ) : products.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">{t("noMatches")}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {products.map((p) => {
              const inStock = isInStock(p);
              return (
                <Card key={p.id} className="overflow-hidden p-0">
                  <div className="relative aspect-square bg-muted">
                    {p.image_url ? (
                      // Shopify CDN images; next/image would need a remote pattern per store.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`${p.image_url}${p.image_url.includes("?") ? "&" : "?"}width=400`}
                        alt={p.title}
                        loading="lazy"
                        className="size-full object-cover"
                      />
                    ) : (
                      <div className="flex size-full items-center justify-center text-muted-foreground">
                        <ImageOff className="size-6" />
                      </div>
                    )}
                    {!inStock ? (
                      <Badge variant="destructive" className="absolute left-2 top-2">
                        {t("outOfStock")}
                      </Badge>
                    ) : null}
                  </div>
                  <CardContent className="space-y-1 p-3">
                    <p className="line-clamp-2 text-sm font-medium text-foreground" title={p.title}>
                      {p.title}
                    </p>
                    <p className="text-sm font-semibold text-foreground">{formatPriceRange(p)}</p>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="truncate">
                        {p.tracks_inventory
                          ? t("stockCount", { count: p.total_inventory ?? 0 })
                          : p.product_type || t("untracked")}
                      </span>
                      {p.online_url ? (
                        <a
                          href={p.online_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 text-primary hover:underline"
                          aria-label={t("openInStore")}
                        >
                          <ExternalLink className="size-3.5" />
                        </a>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          {products.length < total ? (
            <div className="flex justify-center">
              <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("loadMore", { shown: products.length, total })}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
