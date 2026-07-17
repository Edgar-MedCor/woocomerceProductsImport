const { askGemini } = require("./geminiService");
const { buildProductPrompt } = require("./promptBuilder");

async function generateDescription(product) {

    const images = (product.images || [])
        .map(img => img.localPath || img.path)
        .filter(Boolean);

    const prompt = buildProductPrompt(product);

    const response = await askGemini(prompt, images);

    try {

        const json = JSON.parse(response);

        return {

            ...product,

            description: json.description,

            shortDescription: json.shortDescription,

            metaDescription: json.metaDescription

        };

    }

    catch (e) {

        console.error(response);

        throw new Error("Gemini devolvió un JSON inválido");

    }

}

module.exports = {
    generateDescription
};