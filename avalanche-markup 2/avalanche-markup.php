<?php
/**
 * Plugin Name: Avalanche Markup
 * Description: Click-to-comment visual feedback overlay for Avalanche client sites. Paste the site's project token under Settings → Avalanche Markup. The overlay only appears for visits with ?markup=TOKEN in the URL — normal visitors never see anything.
 * Version: 1.6.4
 * Author: Avalanche Creative
 * Author URI: https://avalanchegr.com
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const AVMK_OPTION        = 'avalanche_markup_token';
const AVMK_NOTIFY_OPTION = 'avalanche_markup_notify';

// Self-hosted update feed. The plugin checks this manifest (committed in
// the repo, served raw from GitHub) and offers a one-click update on the
// Plugins screen whenever its `version` is newer than what's installed —
// so pushing a plugin change makes the update available on every site.
const AVMK_UPDATE_MANIFEST = 'https://raw.githubusercontent.com/lancebeaudry/Web-Annotations/main/wordpress-plugin/update.json';

// Pin to a specific commit of github.com/lancebeaudry/Web-Annotations.
// jsDelivr serves a commit-pinned URL instantly and immutably (cached
// a year), so there's no @main resolution lag, no cache purges, and no
// stale browser copies — when we ship an update the ref changes, which
// is a brand-new URL every browser fetches fresh. Bump AVMK_REF on each
// release with `npm run release` (admin/release.mjs).
const AVMK_REF = '7f0c569';

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

// Admin-bar shortcut for logged-in users: one click to enter feedback
// mode on the page you're viewing (adds ?markup=TOKEN). Only shown when a
// token is configured. On a wp-admin screen it links to the site home.
add_action( 'admin_bar_menu', function ( $bar ) {
	$token = get_option( AVMK_OPTION, '' );
	if ( ! $token ) {
		return;
	}
	$href = is_admin()
		? home_url( '/?markup=' . rawurlencode( $token ) )
		: esc_url_raw( add_query_arg( 'markup', $token ) );
	$bar->add_node( [
		'id'    => 'avalanche-markup',
		'title' => '<span class="ab-icon"></span>Markup',
		'href'  => $href,
		'meta'  => [ 'title' => 'Enter feedback / markup mode on this page' ],
	] );
}, 100 );

// Dashicon for the admin-bar item (front end + wp-admin).
function avmk_adminbar_css() {
	if ( ! is_admin_bar_showing() || ! get_option( AVMK_OPTION, '' ) ) {
		return;
	}
	echo '<style>#wpadminbar #wp-admin-bar-avalanche-markup .ab-icon:before{content:"\f464";top:3px;}</style>' . "\n";
}
add_action( 'wp_head', 'avmk_adminbar_css' );
add_action( 'admin_head', 'avmk_adminbar_css' );

// ---------------------------------------------------------------------
// Self-hosted updates: read the repo's update.json and offer a one-click
// update on the Plugins screen when a newer version is published. Lets a
// plain `git push` of a plugin change roll out to every WP Engine site.
// ---------------------------------------------------------------------

// Fetch + cache the update manifest (1h) so we don't hit GitHub on every
// admin page load.
function avmk_update_manifest() {
	$cached = get_transient( 'avmk_update_manifest' );
	if ( false !== $cached ) {
		return $cached ?: null;
	}
	$res = wp_remote_get( AVMK_UPDATE_MANIFEST, [ 'timeout' => 10 ] );
	$data = null;
	if ( ! is_wp_error( $res ) && 200 === (int) wp_remote_retrieve_response_code( $res ) ) {
		$data = json_decode( wp_remote_retrieve_body( $res ) );
	}
	set_transient( 'avmk_update_manifest', $data ?: 0, HOUR_IN_SECONDS );
	return $data;
}

// Inject our update into the list WordPress shows on the Plugins screen.
add_filter( 'site_transient_update_plugins', function ( $transient ) {
	if ( empty( $transient->checked ) ) {
		return $transient;
	}
	$basename  = plugin_basename( __FILE__ );
	$installed = $transient->checked[ $basename ] ?? '0';
	$m         = avmk_update_manifest();
	if ( $m && ! empty( $m->version ) && version_compare( $m->version, $installed, '>' ) ) {
		$transient->response[ $basename ] = (object) [
			'slug'        => 'avalanche-markup',
			'plugin'      => $basename,
			'new_version' => $m->version,
			'package'     => $m->download_url ?? '',
			'url'         => $m->homepage ?? 'https://avalanchegr.com',
			'tested'      => $m->tested ?? '',
		];
	}
	return $transient;
}, 10, 1 );

// Provide the "View details" popup content.
add_filter( 'plugins_api', function ( $result, $action, $args ) {
	if ( 'plugin_information' !== $action || empty( $args->slug ) || 'avalanche-markup' !== $args->slug ) {
		return $result;
	}
	$m = avmk_update_manifest();
	if ( ! $m ) {
		return $result;
	}
	return (object) [
		'name'          => 'Avalanche Markup',
		'slug'          => 'avalanche-markup',
		'version'       => $m->version ?? '',
		'author'        => 'Avalanche Creative',
		'homepage'      => $m->homepage ?? 'https://avalanchegr.com',
		'download_link' => $m->download_url ?? '',
		'tested'        => $m->tested ?? '',
		'sections'      => [ 'changelog' => $m->changelog ?? 'See the repository for changes.' ],
	];
}, 20, 3 );

// Drop our manifest cache right after WordPress runs an update check, so
// a manual "Check again" reflects a fresh push without a stale 1h wait.
add_action( 'upgrader_process_complete', function () {
	delete_transient( 'avmk_update_manifest' );
} );

// WordPress -> Supabase auto-sign-in bridge. The overlay calls this from
// the visitor's browser; if they're logged into WordPress, we ask the
// Supabase `wp-session` Edge Function (proven by a shared secret kept in
// wp-config) to mint a real session for their WP email and hand the
// tokens back. Logged-out visitors fall through to the 6-digit code flow.
// Returns no per-user data unless the request carries the user's own auth
// cookie, so cached responses can't leak one user's session to another.
add_action( 'rest_api_init', function () {
	register_rest_route( 'avalanche-markup/v1', '/session', [
		'methods'             => 'GET',
		'permission_callback' => '__return_true',
		'callback'            => 'avmk_rest_session',
	] );
} );

function avmk_rest_session() {
	nocache_headers();

	if ( ! is_user_logged_in() ) {
		return [ 'loggedIn' => false ];
	}

	// Only WordPress roles that actually edit the site auto-sign-in.
	// Low-privilege roles (subscribers, customers, members) fall through
	// to the email-code flow and still need an explicit invite — so an
	// ecommerce/membership site's customers can't slip in via the bridge.
	$cap = apply_filters( 'avalanche_markup_bridge_capability', 'edit_posts' );
	if ( ! current_user_can( $cap ) ) {
		return [ 'loggedIn' => true, 'bridge' => false ];
	}

	$secret = defined( 'AVALANCHE_MARKUP_WP_AUTH_SECRET' ) ? AVALANCHE_MARKUP_WP_AUTH_SECRET : '';
	$base   = defined( 'AVALANCHE_MARKUP_SUPABASE_URL' ) ? AVALANCHE_MARKUP_SUPABASE_URL : '';
	if ( ! $secret || ! $base ) {
		// Logged in, but this site hasn't enabled the WP bridge.
		return [ 'loggedIn' => true, 'bridge' => false ];
	}

	$user = wp_get_current_user();
	$res  = wp_remote_post( untrailingslashit( $base ) . '/functions/v1/wp-session', [
		'headers' => [ 'Content-Type' => 'application/json', 'x-wp-auth-secret' => $secret ],
		'body'    => wp_json_encode( [
			'email'       => $user->user_email,
			'name'        => $user->display_name,
			'token'       => get_option( AVMK_OPTION, '' ),
			'redirect_to' => home_url( '/' ),
		] ),
		'timeout' => 15,
	] );

	if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) {
		return [ 'loggedIn' => true, 'bridge' => false ];
	}
	$data = json_decode( wp_remote_retrieve_body( $res ), true );
	return [
		'loggedIn'      => true,
		'bridge'        => true,
		'access_token'  => $data['access_token'] ?? null,
		'refresh_token' => $data['refresh_token'] ?? null,
		'email'         => $data['email'] ?? $user->user_email,
	];
}

add_action( 'admin_init', function () {
	register_setting( 'avalanche_markup', AVMK_OPTION, [ 'sanitize_callback' => 'sanitize_text_field' ] );
	register_setting( 'avalanche_markup', AVMK_NOTIFY_OPTION, [ 'sanitize_callback' => 'avmk_sanitize_emails' ] );
} );

// Normalize the notify-list textarea to one valid, lower-cased, de-duped
// email per line.
function avmk_sanitize_emails( $raw ) {
	$out = [];
	foreach ( preg_split( '/[\s,;]+/', (string) $raw ) as $candidate ) {
		$email = sanitize_email( trim( $candidate ) );
		if ( $email && is_email( $email ) ) {
			$out[ strtolower( $email ) ] = true;
		}
	}
	return implode( "\n", array_keys( $out ) );
}

// Shared Supabase credentials from wp-config.php constants, or null if
// the site hasn't been wired up. The service-role key must never live in
// this file, the options table, or version control.
function avmk_creds() {
	$base = defined( 'AVALANCHE_MARKUP_SUPABASE_URL' ) ? AVALANCHE_MARKUP_SUPABASE_URL : '';
	$key  = defined( 'AVALANCHE_MARKUP_SERVICE_KEY' ) ? AVALANCHE_MARKUP_SERVICE_KEY : '';
	if ( ! $base || ! $key ) {
		return null;
	}
	return [
		'base'    => untrailingslashit( $base ),
		'headers' => [
			'apikey'        => $key,
			'Authorization' => 'Bearer ' . $key,
			'Content-Type'  => 'application/json',
		],
	];
}

// This site's Supabase project id (matched by site_url = home_url()), or
// '' if it isn't registered yet.
function avmk_project_id( $creds ) {
	$res = wp_remote_get(
		$creds['base'] . '/rest/v1/projects?select=id&site_url=eq.' . rawurlencode( untrailingslashit( home_url() ) ),
		[ 'headers' => $creds['headers'], 'timeout' => 15 ]
	);
	if ( is_wp_error( $res ) ) {
		return '';
	}
	$rows = json_decode( wp_remote_retrieve_body( $res ), true );
	return ( is_array( $rows ) && ! empty( $rows[0]['id'] ) ) ? $rows[0]['id'] : '';
}

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

// Push the team notify-list to Supabase so the notifier Edge Function can
// read it. Same two-places problem as the token: this list is edited in
// WP, but the mailer lives in Supabase.
add_action( 'add_option_' . AVMK_NOTIFY_OPTION, function ( $option, $value ) {
	avmk_sync_notify( $value );
}, 10, 2 );
add_action( 'update_option_' . AVMK_NOTIFY_OPTION, function ( $old, $new ) {
	avmk_sync_notify( $new );
}, 10, 2 );

/**
 * Rename (or create) this site's Supabase projects row so its token
 * matches what's saved here. The row is matched by site_url = home_url(),
 * so the rename keeps any existing comments attached. Credentials come
 * from wp-config.php constants — the service-role key must never live in
 * this file, the options table, or version control.
 */
function avmk_sync_token( $old_token, $new_token ) {
	$creds     = avmk_creds();
	$new_token = trim( (string) $new_token );

	if ( ! $creds ) {
		avmk_notice( 'warning', 'Token saved locally, but not synced to Supabase: add AVALANCHE_MARKUP_SUPABASE_URL and AVALANCHE_MARKUP_SERVICE_KEY to wp-config.php.' );
		return;
	}
	if ( '' === $new_token ) {
		return; // Cleared field — nothing to point at.
	}

	$base    = $creds['base'];
	$site    = untrailingslashit( home_url() );
	$headers = $creds['headers'];

	// Find the row for this site (independent of the token, which may
	// be the value we're about to overwrite).
	$project_id = avmk_project_id( $creds );

	if ( $project_id ) {
		$res = wp_remote_request(
			$base . '/rest/v1/projects?id=eq.' . rawurlencode( $project_id ),
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

/**
 * Replace this project's notify_recipients in Supabase with the saved
 * list. These are the people emailed when a client leaves a comment.
 */
function avmk_sync_notify( $value ) {
	$creds = avmk_creds();
	if ( ! $creds ) {
		avmk_notice( 'warning', 'Notify list saved locally, but not synced: add the Supabase constants to wp-config.php.' );
		return;
	}
	$project_id = avmk_project_id( $creds );
	if ( ! $project_id ) {
		avmk_notice( 'warning', 'Notify list saved, but this site has no Supabase project yet — save the token first, then re-save the list.' );
		return;
	}

	$emails = array_filter( array_map( 'trim', preg_split( '/\R/', (string) $value ) ) );
	$base   = $creds['base'];
	$where  = '/rest/v1/notify_recipients?project_id=eq.' . rawurlencode( $project_id );

	// Replace wholesale: clear this project's rows, then insert the set.
	$del = wp_remote_request( $base . $where, [
		'method'  => 'DELETE',
		'headers' => $creds['headers'] + [ 'Prefer' => 'return=minimal' ],
		'timeout' => 15,
	] );
	if ( is_wp_error( $del ) ) {
		avmk_notice( 'error', 'Could not update the notify list in Supabase: ' . $del->get_error_message() );
		return;
	}

	if ( ! $emails ) {
		avmk_notice( 'success', 'Notify list cleared — no one will be emailed on new comments.' );
		return;
	}

	$rows = array_map( fn( $e ) => [ 'project_id' => $project_id, 'email' => strtolower( $e ) ], $emails );
	$ins  = wp_remote_post( $base . '/rest/v1/notify_recipients', [
		'headers' => $creds['headers'] + [ 'Prefer' => 'return=minimal' ],
		'body'    => wp_json_encode( $rows ),
		'timeout' => 15,
	] );
	if ( is_wp_error( $ins ) ) {
		avmk_notice( 'error', 'Could not save the notify list: ' . $ins->get_error_message() );
		return;
	}
	$code = wp_remote_retrieve_response_code( $ins );
	if ( $code >= 200 && $code < 300 ) {
		avmk_notice( 'success', sprintf( 'Notify list synced — %d %s will be emailed on new client comments.', count( $emails ), count( $emails ) === 1 ? 'person' : 'people' ) );
	} else {
		avmk_notice( 'error', 'Supabase rejected the notify list (HTTP ' . $code . '): ' . esc_html( wp_remote_retrieve_body( $ins ) ) );
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
	$token  = get_option( AVMK_OPTION, '' );
	$notify = get_option( AVMK_NOTIFY_OPTION, '' );
	?>
	<div class="wrap">
		<h1>Avalanche Markup</h1>
		<p>Paste this site's project token. Feedback mode then activates only for visits with <code>?markup=TOKEN</code> in the URL — regular visitors never see anything.</p>
		<form method="post" action="options.php">
			<?php settings_fields( 'avalanche_markup' ); ?>

			<h2 class="title">Project token</h2>
			<input type="text" class="regular-text code" name="<?php echo esc_attr( AVMK_OPTION ); ?>" value="<?php echo esc_attr( $token ); ?>" placeholder="e.g. client-name-1a2b3c4d">

			<h2 class="title">Email notifications</h2>
			<p>Who should be emailed when a client leaves a new comment on this site? One email address per line. Leave blank to turn notifications off.</p>
			<textarea class="large-text code" rows="4" name="<?php echo esc_attr( AVMK_NOTIFY_OPTION ); ?>" placeholder="you@avalanchegr.com&#10;teammate@avalanchegr.com"><?php echo esc_textarea( $notify ); ?></textarea>
			<p class="description">@mentions inside a comment always notify the person tagged — this list is the extra "tell the team about any new feedback" alert.</p>

			<?php submit_button( 'Save settings' ); ?>
		</form>
		<?php if ( $token ) : ?>
			<p>Share link for this site: <code><?php echo esc_html( home_url( '/?markup=' . $token ) ); ?></code></p>
		<?php endif; ?>
	</div>
	<?php
}
