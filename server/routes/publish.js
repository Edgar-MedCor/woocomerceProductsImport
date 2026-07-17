const express = require('express');
const { productToWooPayload, variationToWooPayload } = require('../services/wooMapper');
const { createWooClient, findProductBySku, findVariationBySku } = require('../services/wooClient');
const { prepareStore } = require('../services/storePreparer');
const { resolveImagesForProducts } = require('../services/mediaService');

const router = express.Router();

function skipReasonForMode(exists, mode) {
  if (mode === 'create_only' && exists) return 'exists';
  if (mode === 'update_only' && !exists) return 'not_found';
  return '';
}

router.post('/', async (req, res) => {

  try {

    const {
      products = [],
      mode = 'auto',
      dryRun = true,
      prepareCatalog = true,
      defaultStatus = '',
      inventoryOnly = false,
    } = req.body;

    const effectiveDryRun =
      dryRun ||
      String(process.env.DRY_RUN).toLowerCase() === 'true';

    const report = [];

    /*
     * ============================
     * DRY RUN
     * ============================
     */

    if (effectiveDryRun) {

      for (const product of products.slice(0, 1000)) {

        if (inventoryOnly) {

          report.push({

            sku: product.sku,

            type: product.type,

            action: 'preview_inventory',

            payload: {

              manage_stock: true,

              stock_quantity:
                product.stock !== null &&
                product.stock !== undefined &&
                product.stock !== ''
                  ? Number(product.stock)
                  : 0

            }

          });

          continue;

        }

        if (product.type === 'variation') {

          report.push({

            sku: product.sku,

            type: product.type,

            action: 'preview_variation',

            payload: variationToWooPayload(product)

          });

        } else {

          report.push({

            sku: product.sku,

            type: product.type,

            action: 'preview_product',

            payload: productToWooPayload(product)

          });

        }

      }

      return res.json({

        ok: true,

        dryRun: true,

        mode,

        inventoryOnly,

        report

      });

    }

    /*
     * ============================
     * WOOCOMMERCE
     * ============================
     */

    const api = createWooClient();

    const context =
      prepareCatalog && !inventoryOnly
        ? await prepareStore(api, products, { createMissing: true })
        : {
            categoryMap: {},
            tagMap: {},
            attributeMap: {},
            termMap: {},
          };

    const mapperContext = {

      categoryMap: context.categoryMap || {},

      tagMap: context.tagMap || {},

      attributeMap: context.attributeMap || {},

      termMap: context.termMap || {},

      defaultStatus: defaultStatus || undefined,

    };

    const productIdBySku = {};

    const productsWithResolvedImages = inventoryOnly

      ? products

      : await resolveImagesForProducts(products);

    const parentProducts = productsWithResolvedImages.filter(

      (product) => product.type !== 'variation'

    );

    const variations = productsWithResolvedImages.filter(

      (product) => product.type === 'variation'

    );

        /*
     * ==========================================
     * PRODUCTOS PADRE (SIMPLE Y VARIABLE)
     * ==========================================
     */

    for (const product of parentProducts) {

      if (product.errors?.length) {

        report.push({

          sku: product.sku,

          status: 'skipped',

          reason: product.errors.join(', ')

        });

        continue;

      }

      const existing = await findProductBySku(api, product.sku);

      /*
       * ==========================
       * SOLO INVENTARIO
       * ==========================
       */

      if (inventoryOnly) {

        if (!existing) {

          report.push({

            sku: product.sku,

            status: 'error',

            action: 'inventory_not_found',

            reason: 'Producto no encontrado'

          });

          continue;

        }

        await api.put(

          `products/${existing.id}`,

          {

            manage_stock: true,

            stock_quantity:

              product.stock !== null &&

              product.stock !== undefined

                ? Number(product.stock)

                : 0

          }

        );

        productIdBySku[product.sku] = existing.id;

        report.push({

          sku: product.sku,

          status: 'success',

          action: 'inventory_updated',

          id: existing.id,

          stock: product.stock

        });

        continue;

      }

      /*
       * ==========================
       * CATÁLOGO COMPLETO
       * ==========================
       */

      const skipReason = skipReasonForMode(Boolean(existing), mode);

      const payload = productToWooPayload(

        product,

        mapperContext

      );

      if (skipReason) {

        report.push({

          sku: product.sku,

          status: 'skipped',

          action: skipReason

        });

        if (existing?.id)

          productIdBySku[product.sku] = existing.id;

        continue;

      }

      if (existing) {

        const updated = await api.put(

          `products/${existing.id}`,

          payload

        );

        productIdBySku[product.sku] = updated.data.id;

        report.push({

          sku: product.sku,

          status: 'success',

          action: 'updated',

          id: updated.data.id

        });

      } else {

        const created = await api.post(

          'products',

          payload

        );

        productIdBySku[product.sku] = created.data.id;

        report.push({

          sku: product.sku,

          status: 'success',

          action: 'created',

          id: created.data.id

        });

      }

    }
        /*
     * ==========================================
     * VARIACIONES
     * ==========================================
     */

    for (const variation of variations) {

      if (variation.errors?.length) {

        report.push({

          sku: variation.sku,

          status: 'skipped',

          reason: variation.errors.join(', ')

        });

        continue;

      }

      let parentId = productIdBySku[variation.parentSku];

      if (!parentId && variation.parentSku) {

        const parent = await findProductBySku(

          api,

          variation.parentSku

        );

        parentId = parent?.id;

      }

      if (!parentId) {

        report.push({

          sku: variation.sku,

          status: 'error',

          action: 'variation_failed',

          reason: `No se encontró producto padre ${variation.parentSku}`

        });

        continue;

      }

      const existingVariation = await findVariationBySku(

        api,

        parentId,

        variation.sku

      );

      /*
       * ==========================
       * SOLO INVENTARIO
       * ==========================
       */

      if (inventoryOnly) {

        if (!existingVariation) {

          report.push({

            sku: variation.sku,

            status: 'error',

            action: 'variation_inventory_not_found',

            reason: 'Variación no encontrada'

          });

          continue;

        }

        await api.put(

          `products/${parentId}/variations/${existingVariation.id}`,

          {

            manage_stock: true,

            stock_quantity:

              variation.stock !== null &&

              variation.stock !== undefined

                ? Number(variation.stock)

                : 0

          }

        );

        report.push({

          sku: variation.sku,

          status: 'success',

          action: 'variation_inventory_updated',

          id: existingVariation.id,

          parentId,

          stock: variation.stock

        });

        continue;

      }

      /*
       * ==========================
       * CATÁLOGO COMPLETO
       * ==========================
       */

      const payload = variationToWooPayload(

        variation,

        mapperContext

      );

      if (existingVariation) {

        if (mode === 'create_only') {

          report.push({

            sku: variation.sku,

            status: 'skipped',

            action: 'variation_exists'

          });

          continue;

        }

        const updated = await api.put(

          `products/${parentId}/variations/${existingVariation.id}`,

          payload

        );

        report.push({

          sku: variation.sku,

          status: 'success',

          action: 'variation_updated',

          id: updated.data.id,

          parentId

        });

      } else {

        if (mode === 'update_only') {

          report.push({

            sku: variation.sku,

            status: 'skipped',

            action: 'variation_not_found'

          });

          continue;

        }

        const created = await api.post(

          `products/${parentId}/variations`,

          payload

        );

        report.push({

          sku: variation.sku,

          status: 'success',

          action: 'variation_created',

          id: created.data.id,

          parentId

        });

      }

    }

    res.json({

      ok: true,

      dryRun: false,

      mode,

      inventoryOnly,

      preparedCatalog: prepareCatalog && !inventoryOnly
        ? context.created
        : null,

      report

    });

  } catch (error) {

    console.error(error?.response?.data || error);

    res.status(500).json({

      ok: false,

      message: error.message,

      details: error?.response?.data

    });

  }

});

module.exports = router;