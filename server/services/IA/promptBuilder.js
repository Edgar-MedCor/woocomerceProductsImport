function buildProductPrompt(product) {

    return `

Eres un especialista en ecommerce.

Analiza las imágenes del producto y la información disponible.

No inventes datos técnicos.

Si algún dato no puede deducirse, simplemente omítelo.

Genera:

1. Descripción larga en HTML para WooCommerce.

2. Descripción corta.

3. Meta descripción SEO.

Información del producto:

Nombre:
${product.name || ""}

SKU:
${product.sku || ""}

Categoría:
${(product.categories || []).join(" > ")}

Marca:
${product.brand || ""}

Color:
${product.color || ""}

Material:
${product.material || ""}

Atributos:

${(product.attributes || [])
.map(a=>`${a.name}: ${(a.values||[]).join(", ")}`)
.join("\n")}

Devuelve ÚNICAMENTE un JSON válido con esta estructura:

{
    "description":"",
    "shortDescription":"",
    "metaDescription":""
}

`;

}

module.exports = {
    buildProductPrompt
};