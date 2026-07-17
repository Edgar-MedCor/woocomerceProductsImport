require("dotenv").config();

const { generateDescription } = require("./server/services/IA/descriptionGenerator");

(async()=>{

    const product = {

        sku:"CAM001",

        name:"Camisa Blanca",

        categories:["Hombre","Camisas"],

        attributes:[
            {
                name:"Color",
                values:["Blanco"]
            },
            {
                name:"Material",
                values:["Algodón"]
            }
        ],

        images:[
            {
                localPath:"./uploads/CAM001.jpg"
            }
        ]

    };

    const result = await generateDescription(product);

    console.log(result);

})();