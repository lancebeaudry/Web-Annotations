<?php
/**
 * Plugin Name: PinPoint by Avalanche
 * Description: Click-to-comment website feedback, by Avalanche Creative. Paste the site's project token under Settings → PinPoint. The overlay only appears for visits with ?markup=TOKEN in the URL — normal visitors never see anything.
 * Version: 2.2.0
 * Author: Avalanche Creative
 * Author URI: https://avalanchegr.com
 * Update URI: https://pinpoint.avalanchegr.com/
 * License: Proprietary
 * License URI: https://pinpoint.avalanchegr.com/app/terms.html
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const AVMK_OPTION        = 'avalanche_markup_token';
const AVMK_NOTIFY_OPTION = 'avalanche_markup_notify';
// "Open feedback": anyone who opens the share link can comment after
// typing just their name — no WordPress account, no email code.
const AVMK_OPEN_OPTION   = 'avalanche_markup_open';

// The hosted backend. One backend serves every site; override the constant
// only for a self-managed deployment.
const AVMK_DEFAULT_SUPABASE_URL = 'https://vaculezzigjtgbysnajf.supabase.co';
function avmk_supabase_url() {
	$base = defined( 'AVALANCHE_MARKUP_SUPABASE_URL' ) ? AVALANCHE_MARKUP_SUPABASE_URL : '';
	return untrailingslashit( $base ?: AVMK_DEFAULT_SUPABASE_URL );
}
// This site's own bridge secret — per project, rotatable from the dashboard
// or PinPoint → Invite → Site secret. It lives ONLY in wp-config.php. It is
// what lets the plugin sync settings and sign editors in for THIS project
// and nothing else (before 2.0 every site shared one global secret, and
// some carried the service-role key; both are gone).
function avmk_project_secret() {
	return defined( 'AVALANCHE_MARKUP_PROJECT_SECRET' ) ? (string) AVALANCHE_MARKUP_PROJECT_SECRET : '';
}
function avmk_bridge_headers() {
	return [ 'Content-Type' => 'application/json', 'x-avmk-project-secret' => avmk_project_secret() ];
}

// A fresh install gets a random token so share links aren't guessable. The
// project itself is registered the first time the owner opens
// ?markup=TOKEN while signed in (or from the dashboard).
register_activation_hook( __FILE__, function () {
	if ( ! get_option( AVMK_OPTION, '' ) ) {
		add_option( AVMK_OPTION, strtolower( wp_generate_password( 20, false ) ) );
	}
} );

// Update feed. The plugin polls this manifest and offers a one-click update
// on the Plugins screen whenever its `version` is newer than what's
// installed. It lives in Avalanche's public Storage bucket (see
// supabase/distribution.sql and admin/release.mjs) — NOT on GitHub, so it
// keeps working with the repository private. Sites still don't auto-update;
// an admin clicks Update.
const AVMK_UPDATE_MANIFEST = 'https://vaculezzigjtgbysnajf.supabase.co/storage/v1/object/public/markup/plugin/update.json';

// The overlay bundle (markup.js) is shipped INSIDE the plugin and served
// from the site itself — no third-party CDN. This removes the jsDelivr
// dependency (an outage there used to break the tool on every site) and
// guarantees the served bundle always matches this plugin version. The
// bundle updates with the plugin via the self-updater. Cache-busted by
// the file's mtime so a new version is picked up immediately.
add_action( 'wp_head', function () {
	$token = get_option( AVMK_OPTION, '' );
	if ( ! $token ) {
		return;
	}
	$file = plugin_dir_path( __FILE__ ) . 'markup.js';
	if ( ! file_exists( $file ) ) {
		return;
	}

	// For logged-in users, hand the overlay a REST nonce + endpoint so it
	// can call the auto-sign-in bridge. WordPress cookie auth for REST
	// requests requires a nonce, so without this the /session endpoint
	// always reads as logged-out. Emitted only when logged in, so it never
	// lands in a cached logged-out page (and logged-in users bypass the
	// page cache, so the nonce is always fresh).
	if ( is_user_logged_in() ) {
		printf(
			'<script>window.__avmkWp=%s;</script>' . "\n",
			wp_json_encode( [
				'nonce' => wp_create_nonce( 'wp_rest' ),
				'rest'  => esc_url_raw( rest_url( 'avalanche-markup/v1/session' ) ),
			] )
		);
	}

	// data-open tells the overlay that guests may comment. It rides on the
	// script tag (not window.__avmkWp) because that block is emitted only
	// for logged-in users — this flag has to reach logged-out visitors, and
	// the tag is site-level so it stays cache-safe.
	$open = get_option( AVMK_OPEN_OPTION, '' ) ? ' data-open="1"' : '';

	$src = plugins_url( 'markup.js', __FILE__ );
	printf(
		'<script defer src="%s?ver=%s" data-project="%s"%s></script>' . "\n",
		esc_url( $src ),
		esc_attr( (string) filemtime( $file ) ),
		esc_attr( $token ),
		$open
	);
} );

add_action( 'admin_menu', function () {
	add_options_page( 'PinPoint by Avalanche', 'PinPoint', 'manage_options', 'avalanche-markup', 'avmk_settings_page' );
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
		'title' => '<span class="ab-icon"></span>PinPoint',
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
	set_transient( 'avmk_update_manifest', $data ?: 0, $data ? HOUR_IN_SECONDS : 5 * MINUTE_IN_SECONDS );
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
		'name'          => 'PinPoint by Avalanche',
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

// And whenever someone opens Dashboard → Updates ("Check again"), so the
// manifest is refetched on demand instead of waiting out the cache.
add_action( 'load-update-core.php', function () {
	delete_transient( 'avmk_update_manifest' );
} );

// WordPress -> Supabase auto-sign-in bridge. The overlay calls this from
// the visitor's browser; if they're logged into WordPress, we ask the
// `wp-session` Edge Function (proven by this site's own project secret
// from wp-config) to mint a real session for their WP email and hand the
// tokens back. Only the project's owner or invited collaborators get a
// session — never Avalanche staff. Logged-out visitors fall through to the
// email-code flow.
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

	if ( ! avmk_project_secret() ) {
		// Logged in, but this site hasn't been given its Site secret yet.
		return [ 'loggedIn' => true, 'bridge' => false ];
	}

	$user = wp_get_current_user();
	$res  = wp_remote_post( avmk_supabase_url() . '/functions/v1/wp-session', [
		'headers' => avmk_bridge_headers(),
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
	register_setting( 'avalanche_markup', AVMK_OPEN_OPTION, [ 'sanitize_callback' => 'avmk_sanitize_bool' ] );
} );

// Checkbox -> '1' or '' (an unchecked box posts the empty hidden input).
function avmk_sanitize_bool( $raw ) {
	return $raw ? '1' : '';
}

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

// The token is only what the page sends. Registration happens when the
// owner first opens ?markup=TOKEN signed in (the overlay creates the project,
// owned by them) or from the dashboard — so there is nothing to sync here,
// and no backend key is needed on this server.

// Push the team notify-list to Supabase so the notifier Edge Function can
// read it. Same two-places problem as the token: this list is edited in
// WP, but the mailer lives in Supabase.
add_action( 'add_option_' . AVMK_NOTIFY_OPTION, function ( $option, $value ) {
	avmk_sync_notify( $value );
}, 10, 2 );
add_action( 'update_option_' . AVMK_NOTIFY_OPTION, function ( $old, $new ) {
	avmk_sync_notify( $new );
}, 10, 2 );

// Push the "open feedback" toggle to the project row — the overlay reads
// data-open for UI, but RLS reads projects.open_access, so both must agree.
add_action( 'add_option_' . AVMK_OPEN_OPTION, function ( $option, $value ) {
	avmk_sync_open( $value );
}, 10, 2 );
add_action( 'update_option_' . AVMK_OPEN_OPTION, function ( $old, $new ) {
	avmk_sync_open( $new );
}, 10, 2 );

/**
 * Sync the open-feedback flag (and site name) to the project via this
 * site's bridge secret.
 */
function avmk_sync_open( $value ) {
	$on = (bool) $value;
	if ( ! avmk_project_secret() ) {
		avmk_notice( 'warning', 'Open feedback saved locally, but not synced: add AVALANCHE_MARKUP_PROJECT_SECRET to wp-config.php (find it under PinPoint → Invite → Site secret, or in the dashboard).' );
		return;
	}
	$res = wp_remote_post( avmk_supabase_url() . '/functions/v1/project-settings', [
		'headers' => avmk_bridge_headers(),
		'body'    => wp_json_encode( [ 'token' => get_option( AVMK_OPTION, '' ), 'open_access' => $on, 'name' => get_bloginfo( 'name' ) ] ),
		'timeout' => 15,
	] );
	if ( ! is_wp_error( $res ) && 200 === (int) wp_remote_retrieve_response_code( $res ) ) {
		avmk_notice( 'success', $on
			? 'Open feedback is ON — anyone with the share link can comment after entering their name.'
			: 'Open feedback is OFF — visitors must sign in again.' );
		return;
	}
	$why = is_wp_error( $res ) ? $res->get_error_message() : ( 'HTTP ' . wp_remote_retrieve_response_code( $res ) . ' ' . wp_remote_retrieve_body( $res ) );
	avmk_notice( 'error', 'Could not sync open feedback: ' . esc_html( $why ) );
}

/**
 * Replace this project's notify_recipients with the saved list, via this
 * site's bridge secret. These are the people emailed on new comments.
 */
function avmk_sync_notify( $value ) {
	$emails = array_values( array_filter( array_map( 'trim', preg_split( '/\R/', (string) $value ) ) ) );
	if ( ! avmk_project_secret() ) {
		avmk_notice( 'warning', 'Notify list saved locally, but not synced: add AVALANCHE_MARKUP_PROJECT_SECRET to wp-config.php (PinPoint → Invite → Site secret, or the dashboard).' );
		return;
	}
	$res = wp_remote_post( avmk_supabase_url() . '/functions/v1/notify-sync', [
		'headers' => avmk_bridge_headers(),
		'body'    => wp_json_encode( [ 'token' => get_option( AVMK_OPTION, '' ), 'emails' => $emails ] ),
		'timeout' => 15,
	] );
	if ( ! is_wp_error( $res ) && 200 === (int) wp_remote_retrieve_response_code( $res ) ) {
		$n = count( $emails );
		avmk_notice( 'success', $n
			? sprintf( 'Notify list synced — %d %s will be emailed on new comments.', $n, $n === 1 ? 'person' : 'people' )
			: 'Notify list cleared — no one will be emailed on new comments.' );
		return;
	}
	$why = is_wp_error( $res ) ? $res->get_error_message() : ( 'HTTP ' . wp_remote_retrieve_response_code( $res ) . ' ' . wp_remote_retrieve_body( $res ) );
	avmk_notice( 'error', 'Could not sync the notify list: ' . esc_html( $why ) );
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
	$open   = get_option( AVMK_OPEN_OPTION, '' );
	?>
	<div class="wrap">
			<h1>PinPoint <small style="font-weight:400;color:#646970">by Avalanche Creative</small></h1>
			<p>Feedback mode activates only for visits with <code>?markup=TOKEN</code> in the URL — regular visitors never see anything. The first time you open that link while signed in, the site is registered to your account.</p>
			<p class="description">
				Bridge secret:
				<?php if ( avmk_project_secret() ) : ?>
					<strong style="color:#1a7f37">configured</strong> — settings sync and editor auto-sign-in are on.
				<?php else : ?>
					<strong style="color:#b32d2e">not configured</strong> — add <code>define( 'AVALANCHE_MARKUP_PROJECT_SECRET', '…' );</code> to <code>wp-config.php</code>. Get the value from PinPoint → Invite → Site secret on this site, or from the dashboard.
				<?php endif; ?>
			</p>
		<form method="post" action="options.php">
			<?php settings_fields( 'avalanche_markup' ); ?>

			<h2 class="title">Project token</h2>
			<input type="text" class="regular-text code" name="<?php echo esc_attr( AVMK_OPTION ); ?>" value="<?php echo esc_attr( $token ); ?>" placeholder="e.g. acme-site">

			<h2 class="title">Email notifications</h2>
			<p>Who should be emailed when a client leaves a new comment on this site? One email address per line. Leave blank to turn notifications off.</p>
			<textarea class="large-text code" rows="4" name="<?php echo esc_attr( AVMK_NOTIFY_OPTION ); ?>" placeholder="you@example.com&#10;teammate@example.com"><?php echo esc_textarea( $notify ); ?></textarea>
			<p class="description">@mentions inside a comment always notify the person tagged — this list is the extra "tell the team about any new feedback" alert.</p>

			<h2 class="title">Open feedback</h2>
			<?php // Unchecked checkboxes post nothing, so the hidden input carries the "off" value. ?>
			<input type="hidden" name="<?php echo esc_attr( AVMK_OPEN_OPTION ); ?>" value="">
			<label>
				<input type="checkbox" name="<?php echo esc_attr( AVMK_OPEN_OPTION ); ?>" value="1" <?php checked( $open, '1' ); ?>>
				Let anyone with the share link comment — they just enter their name (no login, no email code).
			</label>
			<p class="description">
				Best for staging review. Guests can add, reply to and delete their own comments, and see the whole conversation; they can't resolve, export, or invite.
				<strong>Heads up:</strong> the project token appears in this site's page source, so in practice anyone who can reach this site can comment — only turn this on for staging that's private or obscure, never a public production site.
			</p>

			<?php submit_button( 'Save settings' ); ?>
		</form>
		<?php if ( $token ) : ?>
			<p>
				Share link for this site: <code><?php echo esc_html( home_url( '/?markup=' . $token ) ); ?></code>
				<?php if ( $open ) : ?>
					<br><span class="description">Open feedback is <strong>on</strong> — send this link to anyone and they can start marking up right away.</span>
				<?php endif; ?>
			</p>
		<?php endif; ?>
	</div>
	<?php
}
