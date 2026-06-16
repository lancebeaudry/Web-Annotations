<?php
/**
 * Plugin Name: Avalanche Markup
 * Description: Click-to-comment visual feedback overlay for Avalanche client sites. Paste the site's project token under Settings → Avalanche Markup. The overlay only appears for visits with ?markup=TOKEN in the URL — normal visitors never see anything.
 * Version: 1.2.0
 * Author: Avalanche Creative
 * Author URI: https://avalanchegr.com
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const AVMK_OPTION = 'avalanche_markup_token';

// Pin to a specific commit of github.com/lancebeaudry/Web-Annotations.
// jsDelivr serves a commit-pinned URL instantly and immutably (cached
// a year), so there's no @main resolution lag, no cache purges, and no
// stale browser copies — when we ship an update the ref changes, which
// is a brand-new URL every browser fetches fresh. Bump AVMK_REF on each
// release with `npm run release` (admin/release.mjs).
const AVMK_REF = '41effd9';

add_action( 'wp_head', function () {
	$token = get_option( AVMK_OPTION, '' );
	if ( ! $token ) {
		return;
	}
	$src = 'https://cdn.jsdelivr.net/gh/lancebeaudry/Web-Annotations@' . AVMK_REF . '/dist/markup.js';
	printf(
		'<script defer src="%s" data-project="%s"></script>' . "\n",
		esc_url( $src ),
		esc_attr( $token )
	);
} );

add_action( 'admin_menu', function () {
	add_options_page( 'Avalanche Markup', 'Avalanche Markup', 'manage_options', 'avalanche-markup', 'avmk_settings_page' );
} );

add_action( 'admin_init', function () {
	register_setting( 'avalanche_markup', AVMK_OPTION, [ 'sanitize_callback' => 'sanitize_text_field' ] );
} );

// "Settings" link next to Activate/Deactivate on the Plugins screen.
add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), function ( $links ) {
	array_unshift( $links, '<a href="' . esc_url( admin_url( 'options-general.php?page=avalanche-markup' ) ) . '">Settings</a>' );
	return $links;
} );

function avmk_settings_page() {
	$token = get_option( AVMK_OPTION, '' );
	?>
	<div class="wrap">
		<h1>Avalanche Markup</h1>
		<p>Paste this site's project token. Feedback mode then activates only for visits with <code>?markup=TOKEN</code> in the URL — regular visitors never see anything.</p>
		<form method="post" action="options.php">
			<?php settings_fields( 'avalanche_markup' ); ?>
			<input type="text" class="regular-text code" name="<?php echo esc_attr( AVMK_OPTION ); ?>" value="<?php echo esc_attr( $token ); ?>" placeholder="e.g. client-name-1a2b3c4d">
			<?php submit_button( 'Save token' ); ?>
		</form>
		<?php if ( $token ) : ?>
			<p>Share link for this site: <code><?php echo esc_html( home_url( '/?markup=' . $token ) ); ?></code></p>
		<?php endif; ?>
	</div>
	<?php
}
