<?php
/**
 * Wayan Sync: galería por variación en la API de WooCommerce.
 *
 * WooCommerce guarda una galería por variación (_product_image_gallery), pero su
 * API REST no la expone ni permite escribirla (escribirla por meta_data crea
 * registros duplicados). Esto agrega el campo "gallery_image_ids" a las
 * variaciones de la API (wc/v3/products/<id>/variations), para que el panel
 * Wayan Sync cargue todas las fotos de cada variación.
 *
 * Instalar como snippet PHP en WPCode ("Ejecutar en todas partes") o como
 * plugin en wp-content/mu-plugins/. No cambia nada de la tienda por sí solo.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

// Recibir: "gallery_image_ids": [123, 456] al crear o actualizar una variación.
add_filter( 'woocommerce_rest_pre_insert_product_variation_object', function ( $variation, $request ) {
	if ( isset( $request['gallery_image_ids'] ) && is_array( $request['gallery_image_ids'] ) ) {
		$variation->set_gallery_image_ids( array_filter( array_map( 'absint', $request['gallery_image_ids'] ) ) );
	}
	return $variation;
}, 10, 2 );

// Devolver: la galería de la variación en cada respuesta de la API.
add_filter( 'woocommerce_rest_prepare_product_variation_object', function ( $response, $variation ) {
	$data                      = $response->get_data();
	$data['gallery_image_ids'] = array_map( 'absint', $variation->get_gallery_image_ids() );
	$response->set_data( $data );
	return $response;
}, 10, 2 );
