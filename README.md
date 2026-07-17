# WooCommerce Auto Publisher - MVP Fase 2

Dashboard local para analizar CSV/Excel de productos, limpiar columnas innecesarias, revisar qué se creará o actualizará en una tienda WooCommerce nueva y preparar el catálogo base.

## Incluye

- Parser para exportaciones de WooCommerce.
- Parser para plantilla simple.
- Preview limpio sin columnas vacías.
- Revisión contra tienda nueva por SKU.
- Detección de productos a crear, actualizar o ignorar.
- Detección de categorías, etiquetas, atributos y términos faltantes.
- Creación automática de categorías, etiquetas, atributos y términos.
- Publicación real de productos simples, variables y variaciones usando URLs de imágenes existentes.
- Modo seguro DRY_RUN.

## Instalación

```bash
npm install
npm run dev
```

Abre:

```txt
http://localhost:3000
```

## Conexión con WooCommerce

Copia `.env.example` a `.env` y llena:

```env
WOO_URL=https://nueva-tienda.com
WOO_KEY=ck_xxxxxxxxx
WOO_SECRET=cs_xxxxxxxxx
DRY_RUN=true
```

Mantén `DRY_RUN=true` mientras pruebas. Para permitir publicación real, cambia:

```env
DRY_RUN=false
```

## Flujo recomendado

1. Sube el CSV.
2. Haz clic en **Analizar archivo**.
3. Haz clic en **Revisar contra tienda nueva**.
4. Revisa productos a crear/actualizar y catálogo faltante.
5. Haz clic en **Preparar catálogo**.
6. Prueba con **Solo preview / no publicar**.
7. Cuando todo esté correcto, cambia `.env` a `DRY_RUN=false` y usa publicación real.

## Pendiente para Fase 3

- Subida real de imágenes locales a WordPress Media Library vía `/wp-json/wp/v2/media`.
- Reemplazo inteligente de imágenes del CSV por imágenes locales.
- Logs descargables en CSV.
- Historial de cargas.


## Fase 3: imágenes locales desde el dashboard

Cuando subes imágenes desde el dashboard, primero se guardan temporalmente en `/uploads`.
Antes de crear o actualizar el producto, el sistema ahora las sube a WordPress usando:

```txt
POST /wp-json/wp/v2/media
```

Para que funcione necesitas configurar en `.env`:

```env
WP_USER=tu_usuario_wordpress
WP_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx
```

La `WP_APP_PASSWORD` se crea en WordPress > Usuarios > Perfil > Contraseñas de aplicación.
No es la contraseña normal del usuario ni las API keys de WooCommerce.

Si `DRY_RUN=true`, las imágenes no se suben; solo se genera preview/payload.
Para publicación real usa `DRY_RUN=false` y en el dashboard elige publicar.
