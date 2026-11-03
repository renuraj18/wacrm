"use client";

import { useEffect, useRef, useState } from "react";
import { ImageOff, Loader2, Search, ShoppingBag } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  formatPriceRange,
  isInStock,
  type ProductListItem,
} from "@/lib/products/format";

interface ProductPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (product: ProductListItem) => void;
}

/**
 * Search the synced Shopify catalogue and pick a product to send. The
 * caller decides how it is sent (photo + caption, or text when the
 * product has no image).
 */
export function ProductPicker({ open, onOpenChange, onPick }: ProductPickerProps) {
  const t = useTranslations("Inbox.composer");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ProductListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    if (!open) return;
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: "30" });
        if (query.trim()) params.set("q", query.trim());
        const res = await fetch(`/api/products?${params}`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (id === requestId.current) {
          setItems(res.ok ? ((data.products as ProductListItem[]) ?? []) : []);
        }
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [open, query]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("products")}</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("productsSearch")}
            className="pl-9"
          />
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {loading && items.length === 0 ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
              <ShoppingBag className="h-5 w-5" />
              {query ? t("productsNoMatch") : t("productsEmpty")}
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {items.map((p) => {
                const inStock = isInStock(p);
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => onPick(p)}
                      className="flex w-full items-center gap-3 rounded-md border border-border bg-muted/40 p-2 text-left hover:border-primary/50 hover:bg-muted"
                    >
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                        {p.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={`${p.image_url}${p.image_url.includes("?") ? "&" : "?"}width=120`}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <ImageOff className="h-4 w-4 text-muted-foreground" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {p.title}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {formatPriceRange(p)} ·{" "}
                          <span className={inStock ? undefined : "text-destructive"}>
                            {inStock ? t("productInStock") : t("productOutOfStock")}
                          </span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
