const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

function getMimeType(file) {

    const ext = path.extname(file).toLowerCase();

    switch (ext) {
        case ".jpg":
        case ".jpeg":
            return "image/jpeg";

        case ".png":
            return "image/png";

        case ".webp":
            return "image/webp";

        case ".gif":
            return "image/gif";

        case ".avif":
            return "image/avif";

        default:
            return "application/octet-stream";
    }
}

async function askGemini(prompt, imagePaths = []) {

    const parts = [];

    parts.push({
        text: prompt
    });

    for (const img of imagePaths) {

        if (!fs.existsSync(img))
            continue;

        const bytes = fs.readFileSync(img);

        parts.push({
            inlineData: {
                mimeType: getMimeType(img),
                data: bytes.toString("base64")
            }
        });

    }

    const response = await ai.models.generateContent({

        model: MODEL,

        contents: [
            {
                role: "user",
                parts
            }
        ]

    });

    return response.text;

}

module.exports = {
    askGemini
};