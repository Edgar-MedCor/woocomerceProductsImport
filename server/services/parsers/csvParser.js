const XLSX = require('xlsx');

const { parseWooExport } = require('./wooExportParser');
const { parseSimpleTemplate } = require('./simpleTemplateParser');

function detectFormat(filePath) {

    const workbook = XLSX.readFile(filePath);

    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    const rows = XLSX.utils.sheet_to_json(sheet, {

        header:1,

        defval:''

    });

    const headers = (rows[0] || []).map(h => String(h).trim());

    if (

        headers.includes("SKU") &&

        headers.includes("Inventario")

    ) {

        return "woocommerce_export";

    }

    return "simple_template";

}

function parseProductFile(filePath){

    const format = detectFormat(filePath);

    if(format==="woocommerce_export")
        return parseWooExport(filePath);

    return parseSimpleTemplate(filePath);

}

module.exports={
    parseProductFile,
    detectFormat
};