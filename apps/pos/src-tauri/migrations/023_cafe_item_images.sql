-- Store a compact, normalized JPEG thumbnail for each café product.
ALTER TABLE local_inventory_items ADD COLUMN image_data_url TEXT;
