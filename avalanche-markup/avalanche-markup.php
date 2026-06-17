<?php
/**
 * Plugin Name: Avalanche Markup
 * Description: Click-to-comment visual feedback overlay for Avalanche client sites. Paste the site's project token under Settings → Avalanche Markup. The overlay only appears for visits with ?markup=TOKEN in the URL — normal visitors never see anything.
 * Version: 1.3.0
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

// Keep the Supabase `projects` row in sync with the token field. The
// token lives in two places — this WP option (what the page sends) and
// the projects table (what the tool recognizes). If they drift, visits
// get "unknown project token". These hooks fire whenever the token is
// saved here and push the new value to Supabase so the two never split.
add_action( 'add_option_' . AVMK_OPTION, function ( $option, $value ) {
	avmk_sync_token( '', $value );
}, 10, 2 );
add_action( 'update_option_' . AVMK_OPTION, function ( $old, $new ) {
	avmk_sync_token( $old, $new );
}, 10, 2 );

/**
 * Rename (or create) this site's Supabase projects row so its token
 * matches what's saved here. The row is matched by site_url = home_url(),
 * so the rename keeps any existing comments attached. Credentials come
 * from wp-config.php constants — the service-role key must never live in
 * this file, the options table, or version control.
 */
function avmk_sync_token( $old_token, $new_token ) {
	$base = defined( 'AVALANCHE_MARKUP_SUPABASE_URL' ) ? AVALANCHE_MARKUP_SUPABASE_URL : '';
	$key  = defined( 'AVALANCHE_MARKUP_SERVICE_KEY' ) ? AVALANCHE_MARKUP_SERVICE_KEY : '';
	$new_token = trim( (string) $new_token );

	if ( ! $base || ! $key ) {
		avmk_notice( 'warning', 'Token saved locally, but not synced to Supabase: add AVALANCHE_MARKUP_SUPABASE_URL and AVALANCHE_MARKUP_SERVICE_KEY to wp-config.php.' );
		return;
	}
	if ( '' === $new_token ) {
		return; // Cleared field — nothing to point at.
	}

	$base    = untrailingslashit( $base );
	$site    = untrailingslashit( home_url() );
	$headers = [
		'apikey'        => $key,
		'Authorization' => 'Bearer ' . $key,
		'Content-Type'  => 'application/json',
	];

	// Find the row for this site (independent of the token, which may
	// be the value we're about to overwrite).
	$lookup = wp_remote_get(
		$base . '/rest/v1/projects?select=id&site_url=eq.' . rawurlencode( $site ),
		[ 'headers' => $headers, 'timeout' => 15 ]
	);
	if ( is_wp_error( $lookup ) ) {
		avmk_notice( 'error', 'Could not reach Supabase to sync the token: ' . $lookup->get_error_message() );
		return;
	}
	$rows = json_decode( wp_remote_retrieve_body( $lookup ), true );

	if ( is_array( $rows ) && ! empty( $rows[0]['id'] ) ) {
		$res = wp_remote_request(
			$base . '/rest/v1/projects?id=eq.' . rawurlencode( $rows[0]['id'] ),
			[
				'method'  => 'PATCH',
				'headers' => $headers + [ 'Prefer' => 'return=minimal' ],
				'body'    => wp_json_encode( [ 'token' => $new_token ] ),
				'timeout' => 15,
			]
		);
		$action = 'updated';
	} else {
		$res = wp_remote_post(
			$base . '/rest/v1/projects',
			[
				'headers' => $headers + [ 'Prefer' => 'return=minimal' ],
				'body'    => wp_json_encode( [
					'token'    => $new_token,
					'name'     => get_bloginfo( 'name' ),
					'site_url' => $site,
				] ),
				'timeout' => 15,
			]
		);
		$action = 'created';
	}

	if ( is_wp_error( $res ) ) {
		avmk_notice( 'error', 'Token sync to Supabase failed: ' . $res->get_error_message() );
		return;
	}
	$code = wp_remote_retrieve_response_code( $res );
	if ( $code >= 200 && $code < 300 ) {
		avmk_notice( 'success', sprintf( 'Token synced to Supabase (project %s). %s/?markup=%s is live.', $action, esc_html( $site ), esc_html( $new_token ) ) );
	} elseif ( 409 === $code ) {
		avmk_notice( 'error', sprintf( 'Token "%s" is already used by another site in Supabase — pick a unique value.', esc_html( $new_token ) ) );
	} else {
		avmk_notice( 'error', 'Supabase rejected the token sync (HTTP ' . $code . '): ' . esc_html( wp_remote_retrieve_body( $res ) ) );
	}
}

// Stash a one-shot notice to show after the post-save redirect.
function avmk_notice( $type, $msg ) {
	set_transient( 'avmk_sync_notice', [ 'type' => $type, 'msg' => $msg ], 60 );
}

add_action( 'admin_notices', function () {
	$notice = get_transient( 'avmk_sync_notice' );
	if ( ! $notice ) {
		return;
	}
	delete_transient( 'avmk_sync_notice' );
	printf(
		'<div class="notice notice-%s is-dismissible"><p>%s</p></div>',
		esc_attr( $notice['type'] ),
		wp_kses_post( $notice['msg'] )
	);
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
