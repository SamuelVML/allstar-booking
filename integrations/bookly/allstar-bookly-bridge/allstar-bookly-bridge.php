<?php
/**
 * Plugin Name: All Star Bookly Bridge
 * Description: Private API for the All Star booking Worker. Bookly remains the calendar owner.
 * Version: 0.1.0
 * Requires PHP: 7.4
 *
 * Install on a backed-up staging copy first. This does not replace Access,
 * payment-provider verification or tests against the actual WordPress database.
 * No Bookly vendor file is modified. Configure ALLSTAR_BOOKLY_SECRET (at least
 * 32 characters) and ALLSTAR_BOOKLY_STAFF_ID in wp-config.php.
 * The service map (website service slug => Bookly service ID) ships with the
 * plugin in service-map.json, generated from the Worker catalogue (owner
 * decision D06). ALLSTAR_BOOKLY_SERVICES is optional; when defined it must
 * equal the bundled map exactly, or the bridge refuses every request.
 */
if (!defined('ABSPATH')) { exit; }

final class AllStar_Bookly_Bridge {
    const NS = 'allstar-bookly/v1';

    public static function install() {
        global $wpdb;
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        $charset = $wpdb->get_charset_collate();
        dbDelta("CREATE TABLE {$wpdb->prefix}allstar_bridge_links (
            local_id varchar(100) NOT NULL,
            appointment_id bigint unsigned NOT NULL,
            ca_id bigint unsigned NOT NULL,
            kind varchar(20) NOT NULL,
            handling_minutes int NOT NULL DEFAULT 0,
            PRIMARY KEY  (local_id),
            UNIQUE KEY ca_id (ca_id)
        ) $charset;");
        dbDelta("CREATE TABLE {$wpdb->prefix}allstar_bridge_commands (
            id varchar(100) NOT NULL,
            payload_hash varchar(64) NOT NULL,
            result longtext NOT NULL,
            PRIMARY KEY  (id)
        ) $charset;");
        dbDelta("CREATE TABLE {$wpdb->prefix}allstar_bridge_nonces (
            nonce varchar(64) NOT NULL,
            expires bigint NOT NULL,
            PRIMARY KEY  (nonce)
        ) $charset;");
    }

    public static function schedule($schedules) {
        $schedules['allstar_minute'] = array('interval' => 60, 'display' => 'All Star calendar sync');
        return $schedules;
    }
    public static function initialize() {
        if (defined('ALLSTAR_WORKER_SYNC_URL') && !wp_next_scheduled('allstar_bookly_sync')) {
            wp_schedule_event(time() + 60, 'allstar_minute', 'allstar_bookly_sync');
        }
    }
    public static function tick() {
        if (!defined('ALLSTAR_WORKER_SYNC_URL') || !defined('ALLSTAR_BOOKLY_SECRET')
            || strpos(ALLSTAR_WORKER_SYNC_URL, 'https://') !== 0) { return; }
        $body = '{}'; $timestamp = (string)time(); $nonce = wp_generate_uuid4();
        $signature = hash_hmac('sha256', $timestamp . "\n" . $nonce . "\n/api/bookly/sync\n" . $body, ALLSTAR_BOOKLY_SECRET);
        wp_remote_post(ALLSTAR_WORKER_SYNC_URL, array('timeout' => 55, 'redirection' => 0,
            'headers' => array('Content-Type' => 'application/json', 'X-Allstar-Timestamp' => $timestamp,
                'X-Allstar-Nonce' => $nonce, 'X-Allstar-Signature' => $signature), 'body' => $body));
    }
    public static function serializeNativeWrites() {
        global $wpdb;
        if (!defined('ALLSTAR_BOOKLY_STAFF_ID') || !defined('ALLSTAR_BOOKLY_SECRET')) { return; }
        $action = isset($_REQUEST['action']) && is_string($_REQUEST['action']) ? $_REQUEST['action'] : '';
        if (!in_array($action, array('bookly_save_appointment', 'bookly_save_appointment_form',
            'bookly_delete_customer_appointments', 'bookly_delete_appointment'), true)) { return; }
        $name = 'allstar-bookly-' . (int)ALLSTAR_BOOKLY_STAFF_ID;
        if ((int)$wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, 5)', $name)) !== 1) {
            wp_send_json_error(array('message' => 'Calendar synchronization is busy. Retry shortly.'), 503);
        }
        register_shutdown_function(function() use ($wpdb, $name) {
            // Bookly's native editor recalculates extras. Preserve the bridge's
            // handling buffer for native frontend booking as well as the API.
            $wpdb->query("UPDATE {$wpdb->prefix}bookly_appointments a JOIN {$wpdb->prefix}allstar_bridge_links l ON l.appointment_id=a.id
                SET a.extras_duration=GREATEST(a.extras_duration,l.handling_minutes*60)");
            $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $name));
        });
    }
    /**
     * Website service slug => Bookly service ID, one to one. Returns null when
     * the bundled map is missing or malformed, is not one to one, or differs
     * from an ALLSTAR_BOOKLY_SERVICES override, so the bridge fails closed.
     */
    public static function serviceMap() {
        static $map = false;
        if ($map !== false) { return $map; }
        $map = null;
        $raw = @file_get_contents(__DIR__ . '/service-map.json');
        $decoded = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($decoded) || !isset($decoded['services']) || !is_array($decoded['services']) || !$decoded['services']) { return $map; }
        $bundled = array();
        foreach ($decoded['services'] as $slug => $id) {
            if (!is_string($slug) || $slug === '' || !is_int($id) || $id <= 0) { return $map; }
            $bundled[$slug] = $id;
        }
        if (count(array_unique($bundled)) !== count($bundled)) { return $map; }
        ksort($bundled);
        if (defined('ALLSTAR_BOOKLY_SERVICES')) {
            if (!is_array(ALLSTAR_BOOKLY_SERVICES)) { return $map; }
            $override = array();
            foreach (ALLSTAR_BOOKLY_SERVICES as $slug => $id) { $override[(string)$slug] = is_int($id) ? $id : -1; }
            ksort($override);
            if ($override !== $bundled) { return $map; }
        }
        $map = $bundled;
        return $map;
    }

    public static function adminMenu() {
        add_management_page('All Star Bookly Bridge', 'All Star Bookly Bridge', 'manage_options', 'allstar-bookly-bridge', array(__CLASS__, 'adminPage'));
    }
    public static function adminPage() {
        if (!current_user_can('manage_options')) { return; }
        global $wpdb;
        echo '<div class="wrap"><h1>All Star Bookly Bridge</h1><p>The Bookly interface stays unchanged. Configure the staff and service IDs below in wp-config.php before enabling the Worker.</p>';
        echo '<p>Configuration: ' . (defined('ALLSTAR_BOOKLY_SECRET') && defined('ALLSTAR_BOOKLY_STAFF_ID') && self::serviceMap() !== null ? 'present' : 'incomplete') . '</p>';
        echo '<h2>Staff</h2><table class="widefat"><tr><th>ID</th><th>Name</th></tr>';
        foreach ($wpdb->get_results("SELECT id,full_name FROM {$wpdb->prefix}bookly_staff", ARRAY_A) as $row) {
            echo '<tr><td>' . esc_html($row['id']) . '</td><td>' . esc_html($row['full_name']) . '</td></tr>';
        }
        echo '</table><h2>Services</h2><table class="widefat"><tr><th>ID</th><th>Service</th><th>Minutes</th><th>Price</th></tr>';
        foreach ($wpdb->get_results("SELECT id,title,duration,price FROM {$wpdb->prefix}bookly_services", ARRAY_A) as $row) {
            echo '<tr><td>' . esc_html($row['id']) . '</td><td>' . esc_html($row['title']) . '</td><td>' . esc_html($row['duration'] / 60) . '</td><td>' . esc_html($row['price']) . '</td></tr>';
        }
        echo '</table><p>Keep credentials private. Never publish the shared secret in screenshots.</p></div>';
    }
    public static function routes() {
        foreach (array('snapshot', 'availability', 'command', 'catalogue') as $route) {
            register_rest_route(self::NS, '/' . $route, array(
                'methods' => 'POST',
                'callback' => array(__CLASS__, $route),
                'permission_callback' => array(__CLASS__, 'authorize'),
            ));
        }
    }

    public static function authorize($request) {
        global $wpdb;
        if (!defined('ALLSTAR_BOOKLY_SECRET') || strlen(ALLSTAR_BOOKLY_SECRET) < 32
            || !defined('ALLSTAR_BOOKLY_STAFF_ID') || self::serviceMap() === null
            || !class_exists('Bookly\\Lib\\Utils\\Appointment')
            || !class_exists('BooklyPro\\Lib\\Plugin')) {
            return new WP_Error('bridge_unconfigured', 'Bridge is not configured.', array('status' => 503));
        }
        $timestamp = $request->get_header('x-allstar-timestamp');
        $nonce = $request->get_header('x-allstar-nonce');
        $signature = $request->get_header('x-allstar-signature');
        if (!preg_match('/^\d+$/D', (string)$timestamp) || abs(time() - (int)$timestamp) > 120
            || !preg_match('/^[a-f0-9-]{36}$/D', (string)$nonce)) {
            return new WP_Error('bridge_auth', 'Unauthorized.', array('status' => 403));
        }
        $expected = hash_hmac('sha256', $timestamp . "\n" . $nonce . "\n" . $request->get_route() . "\n" . $request->get_body(), ALLSTAR_BOOKLY_SECRET);
        if (!hash_equals($expected, (string)$signature)) {
            return new WP_Error('bridge_auth', 'Unauthorized.', array('status' => 403));
        }
        $wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->prefix}allstar_bridge_nonces WHERE expires < %d", time()));
        if (!$wpdb->insert($wpdb->prefix . 'allstar_bridge_nonces', array('nonce' => $nonce, 'expires' => time() + 240))) {
            return new WP_Error('bridge_replay', 'Request already used.', array('status' => 403));
        }
        if (get_option('timezone_string') !== 'Europe/Amsterdam') {
            return new WP_Error('bridge_timezone', 'WordPress timezone must be Europe/Amsterdam.', array('status' => 503));
        }
        return true;
    }

    private static function response($data) {
        $response = new WP_REST_Response($data);
        $response->header('Cache-Control', 'private, no-store');
        return $response;
    }

    private static function fail($code, $message, $status = 409) {
        throw new RuntimeException($code . ':' . $message, $status);
    }

    public static function catalogue($request) {
        global $wpdb;
        return self::response(array('staff' => $wpdb->get_results("SELECT id, full_name FROM {$wpdb->prefix}bookly_staff", ARRAY_A),
            'services' => $wpdb->get_results("SELECT id, title, duration, price FROM {$wpdb->prefix}bookly_services", ARRAY_A),
            'configuredStaff' => (int)ALLSTAR_BOOKLY_STAFF_ID, 'serviceMap' => self::serviceMap()));
    }

    private static function rows() {
        global $wpdb;
        // No pagination/truncation: refuse oversized snapshots instead of treating
        // a missing page as deletion. Includes terminal rows and all mapped IDs.
        $rows = $wpdb->get_results($wpdb->prepare("SELECT ca.id AS ca_id, ca.status, ca.notes,
            a.id AS appointment_id, a.start_date, a.end_date, GREATEST(a.extras_duration, COALESCE(l.handling_minutes,0)*60) AS extras_duration,
            a.service_id, a.custom_service_name, a.internal_note, s.padding_left, s.padding_right,
            c.full_name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            s.title AS service_name, COALESCE(a.custom_service_price, s.price, 0) * ca.number_of_persons AS price,
            COALESCE(p.status, 'pending') AS payment_status,
            l.local_id, l.kind,
            (SELECT COUNT(*) FROM {$wpdb->prefix}bookly_customer_appointments x WHERE x.appointment_id = a.id) AS participants
            FROM {$wpdb->prefix}bookly_customer_appointments ca
            JOIN {$wpdb->prefix}bookly_appointments a ON a.id = ca.appointment_id
            JOIN {$wpdb->prefix}bookly_customers c ON c.id = ca.customer_id
            LEFT JOIN {$wpdb->prefix}bookly_services s ON s.id = a.service_id
            LEFT JOIN {$wpdb->prefix}bookly_payments p ON p.id = ca.payment_id
            LEFT JOIN {$wpdb->prefix}allstar_bridge_links l ON l.ca_id = ca.id
            WHERE a.staff_id = %d AND (a.start_date >= DATE_SUB(NOW(), INTERVAL 7 DAY) OR l.local_id IS NOT NULL)
            ORDER BY ca.id LIMIT 5001", (int)ALLSTAR_BOOKLY_STAFF_ID), ARRAY_A);
        if ($wpdb->last_error || count($rows) > 5000) { self::fail('snapshot_limit', 'Complete snapshot unavailable.', 503); }
        return $rows;
    }

    private static function shape($row) {
        $reverse = array_flip(self::serviceMap());
        $status_map = array('approved' => 'confirmed', 'pending' => 'payment_pending', 'done' => 'completed', 'cancelled' => 'cancelled', 'rejected' => 'cancelled', 'waitlisted' => 'waitlisted');
        if (!isset($status_map[$row['status']])) { self::fail('custom_status', 'Map custom Bookly statuses before enabling sync.', 503); }
        $version = hash('sha256', wp_json_encode($row));
        return array(
            'remoteId' => (string)$row['ca_id'], 'localId' => $row['local_id'], 'kind' => $row['kind'] ?: 'appointment',
            'version' => $version, 'serviceId' => $reverse[(int)$row['service_id']] ?? 'bookly-unmapped',
            'serviceName' => $row['service_name'] ?: $row['custom_service_name'] ?: 'Bookly appointment',
            'date' => substr($row['start_date'], 0, 10), 'time' => substr($row['start_date'], 11, 5),
            'endDate' => substr($row['end_date'], 0, 10), 'endTime' => substr($row['end_date'], 11, 5),
            'durationMinutes' => (int)((self::stamp($row['end_date']) - self::stamp($row['start_date'])) / 60),
            'extraMinutes' => (int)ceil($row['extras_duration'] / 60),
            'paddingLeftMinutes' => (int)ceil(($row['padding_left'] ?? 0) / 60), 'paddingRightMinutes' => (int)ceil(($row['padding_right'] ?? 0) / 60),
            'status' => $status_map[$row['status']], 'customerName' => $row['customer_name'],
            'customerEmail' => $row['customer_email'], 'customerPhone' => $row['customer_phone'],
            'notes' => $row['notes'] ?: '', 'priceCents' => (int)round($row['price'] * 100),
            'paid' => $row['payment_status'] === 'completed', 'group' => (int)$row['participants'] !== 1,
        );
    }

    public static function snapshot($request) {
        try { return self::response(array('complete' => true, 'scopeFrom' => wp_date('Y-m-d', time() - 7 * DAY_IN_SECONDS), 'appointments' => array_map(array(__CLASS__, 'shape'), self::rows()))); }
        catch (RuntimeException $e) { return new WP_Error('bridge_snapshot', $e->getMessage(), array('status' => $e->getCode())); }
    }

    private static function mappedService($slug) {
        $id = self::serviceMap()[$slug] ?? null;
        if (!$id || !\Bookly\Lib\Entities\Service::find((int)$id)) { self::fail('service_map', 'Service has not been mapped.', 503); }
        return (int)$id;
    }

    private static function stamp($value) {
        return (new DateTimeImmutable($value, new DateTimeZone('Europe/Amsterdam')))->getTimestamp();
    }
    private static function end($start, $minutes) {
        return (new DateTimeImmutable($start, new DateTimeZone('Europe/Amsterdam')))->modify('+' . $minutes . ' minutes')->format('Y-m-d H:i:s');
    }
    private static function validDate($date) {
        return is_string($date) && preg_match('/^\d{4}-\d{2}-\d{2}$/D', $date)
            && date('Y-m-d', strtotime($date . ' 12:00:00')) === $date;
    }

    private static function free($date, $time, $duration, $service_id, $exclude = 0) {
        global $wpdb;
        $start = $date . ' ' . $time . ':00';
        $end = self::end($start, $duration);
        // checkTime uses the current-user display timezone. The API has no user;
        // Common therefore falls back to WordPress's validated Amsterdam timezone.
        $checks = $service_id ? \Bookly\Lib\Utils\Appointment::checkTime($exclude, $start, $end, (int)ALLSTAR_BOOKLY_STAFF_ID, $service_id, null, array()) : array();
        foreach (array('interval_not_in_staff_schedule', 'interval_not_in_service_schedule', 'staff_reaches_working_time_limit') as $flag) {
            if (!empty($checks[$flag])) { return false; }
        }
        // Bookly's editor overlap check also counts cancelled rows; use active
        // participant statuses here, while conservatively blocking empty events.
        $busy = $wpdb->get_var($wpdb->prepare("SELECT a.id FROM {$wpdb->prefix}bookly_appointments a
            LEFT JOIN {$wpdb->prefix}bookly_services busy_service ON busy_service.id=a.service_id
            WHERE a.staff_id = %d AND a.id != %d AND DATE_SUB(a.start_date,INTERVAL COALESCE(busy_service.padding_left,0) SECOND) < %s
            AND DATE_ADD(a.end_date, INTERVAL (GREATEST(a.extras_duration,COALESCE((SELECT l.handling_minutes*60 FROM {$wpdb->prefix}allstar_bridge_links l WHERE l.appointment_id=a.id LIMIT 1),0)) + COALESCE(busy_service.padding_right,0)) SECOND) > %s
            AND (NOT EXISTS (SELECT 1 FROM {$wpdb->prefix}bookly_customer_appointments x WHERE x.appointment_id = a.id)
                OR EXISTS (SELECT 1 FROM {$wpdb->prefix}bookly_customer_appointments x
                    WHERE x.appointment_id = a.id AND x.status NOT IN ('cancelled','rejected','waitlisted')))
            LIMIT 1", (int)ALLSTAR_BOOKLY_STAFF_ID, $exclude, $end, $start));
        if ($wpdb->last_error) { self::fail('db', 'Availability unavailable.', 503); }
        return !$busy;
    }

    public static function availability($request) {
        try {
            $input = $request->get_json_params();
            $service_id = self::mappedService($input['serviceId'] ?? '');
            $duration = $input['durationMinutes'] ?? 0;
            $days = $input['days'] ?? null;
            if (!is_int($duration) || $duration < 5 || $duration > 480 || !is_array($days) || count($days) > 91) { self::fail('input', 'Invalid availability query.', 400); }
            $exclude = 0;
            if (!empty($input['excludeLocalId'])) {
                global $wpdb;
                $exclude = (int)$wpdb->get_var($wpdb->prepare("SELECT appointment_id FROM {$wpdb->prefix}allstar_bridge_links WHERE local_id = %s", $input['excludeLocalId']));
            }
            $result = array(); $count = 0;
            foreach ($days as $day) {
                if (!self::validDate($day['date'] ?? '') || !is_array($day['times'] ?? null)) { self::fail('input', 'Invalid date.', 400); }
                $times = array();
                foreach ($day['times'] as $time) {
                    if (++$count > 15000 || !preg_match('/^([01]\d|2[0-3]):[0-5][05]$/D', $time)) { self::fail('input', 'Invalid times.', 400); }
                    if (self::free($day['date'], $time, $duration, $service_id, $exclude)) { $times[] = $time; }
                }
                $result[] = array('date' => $day['date'], 'times' => $times);
            }
            return self::response(array('days' => $result));
        } catch (RuntimeException $e) { return new WP_Error('bridge_availability', $e->getMessage(), array('status' => $e->getCode())); }
    }

    public static function command($request) {
        global $wpdb;
        $input = $request->get_json_params();
        if (!is_array($input) || !preg_match('/^[a-zA-Z0-9-]{1,100}$/D', $input['id'] ?? '')
            || !preg_match('/^[a-zA-Z0-9-]{1,100}$/D', $input['localId'] ?? '')) {
            return new WP_Error('bridge_input', 'Invalid command.', array('status' => 400));
        }
        $tables = array('bookly_appointments', 'bookly_customer_appointments', 'bookly_customers',
            'allstar_bridge_links', 'allstar_bridge_commands');
        foreach ($tables as $table) {
            $engine = $wpdb->get_var($wpdb->prepare('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s', $wpdb->prefix . $table));
            if (strtoupper((string)$engine) !== 'INNODB') {
                return new WP_Error('bridge_storage', 'Bridge writes require InnoDB tables.', array('status' => 503));
            }
        }
        $hash = hash('sha256', $request->get_body());
        $lock_name = 'allstar-bookly-' . (int)ALLSTAR_BOOKLY_STAFF_ID;
        if ((int)$wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, 5)', $lock_name)) !== 1) {
            return new WP_Error('bridge_busy', 'Calendar is busy. Retry.', array('status' => 503));
        }
        try {
            $existing = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$wpdb->prefix}allstar_bridge_commands WHERE id = %s", $input['id']), ARRAY_A);
            if ($existing) {
                if (!hash_equals($existing['payload_hash'], $hash)) { self::fail('idempotency', 'Command ID reused with different input.'); }
                return self::response(json_decode($existing['result'], true));
            }
            // All writes, link and idempotency record share one transaction. Bookly
            // notifications are disabled here; the Worker sends its own confirmations.
            $wpdb->query('START TRANSACTION');
            $result = self::apply($input);
            if (!$wpdb->insert($wpdb->prefix . 'allstar_bridge_commands', array('id' => $input['id'], 'payload_hash' => $hash, 'result' => wp_json_encode($result)))) { self::fail('db', 'Could not record command.', 503); }
            if ($wpdb->query('COMMIT') === false) { self::fail('db', 'Could not commit command.', 503); }
            return self::response($result);
        } catch (Throwable $e) {
            $wpdb->query('ROLLBACK');
            return new WP_Error('bridge_command', $e instanceof RuntimeException ? $e->getMessage() : 'Command failed.', array('status' => $e instanceof RuntimeException ? $e->getCode() : 503));
        } finally { $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $lock_name)); }
    }

    private static function apply($input) {
        global $wpdb;
        $block = ($input['kind'] ?? '') === 'block';
        $state = $input['state'] ?? array();
        if (!is_array($state) || !in_array($state['status'] ?? '', array('confirmed','payment_pending','payment_expired','cancelled','completed','removed'), true)) { self::fail('input', 'Invalid state.', 400); }
        $link = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$wpdb->prefix}allstar_bridge_links WHERE local_id = %s", $input['localId']), ARRAY_A);
        $appointment = $link ? \Bookly\Lib\Entities\Appointment::find((int)$link['appointment_id']) : null;
        $ca = $link ? \Bookly\Lib\Entities\CustomerAppointment::find((int)$link['ca_id']) : null;
        if ($link && (!$appointment || !$ca)) { self::fail('deleted', 'Appointment was deleted in Bookly.'); }
        if ($link) {
            $matching = null;
            foreach (self::rows() as $row) { if ((string)$row['ca_id'] === (string)$link['ca_id']) { $matching = self::shape($row); break; } }
            if (!$matching || $matching['group']) { self::fail('group', 'Manage group bookings in Bookly.'); }
            if (($input['expectedVersion'] ?? '') !== $matching['version']) { self::fail('changed', 'Appointment changed in Bookly. Refresh first.'); }
        }
        $terminal = in_array($state['status'], array('cancelled','payment_expired','removed'), true);
        if (!$link && $terminal) { return array('remoteId' => null, 'version' => '', 'terminal' => true); }
        if (!self::validDate($state['date'] ?? '') || !preg_match('/^([01]\d|2[0-3]):[0-5][05]$/D', $state['time'] ?? '')
            || !is_int($state['durationMinutes'] ?? null) || $state['durationMinutes'] < 5 || $state['durationMinutes'] > 1440
            || !is_int($state['handlingMinutes'] ?? null) || $state['handlingMinutes'] < 0 || $state['handlingMinutes'] > 120) { self::fail('input', 'Invalid appointment time.', 400); }
        $service_id = $block ? null : self::mappedService($state['serviceId'] ?? '');
        if (!$block && (int)\Bookly\Lib\Entities\Service::find($service_id)->getDuration() !== $state['durationMinutes'] * 60) { self::fail('duration_map', 'Bookly service duration does not match the website service.', 503); }
        $start = $state['date'] . ' ' . $state['time'] . ':00';
        $end = self::end($start, $state['durationMinutes']);
        $moved = !$appointment || $appointment->getStartDate() !== $start || $appointment->getEndDate() !== $end;
        if (!$terminal && $moved && !self::free($state['date'], $state['time'], $state['durationMinutes'] + $state['handlingMinutes'], $service_id, $appointment ? $appointment->getId() : 0)) { self::fail('slot', 'Time is already occupied in Bookly.'); }
        $status = $terminal ? 'cancelled' : ($state['status'] === 'payment_pending' ? 'pending' : ($state['status'] === 'completed' ? 'done' : 'approved'));
        if (!$appointment) {
            // Use a distinct bridge customer record; never overwrite an existing
            // Bookly customer's profile based on website form input.
            $customer = new \Bookly\Lib\Entities\Customer();
            $customer->setFullName($block ? 'Shop time off' : sanitize_text_field($state['customerName'] ?? ''))
                ->setEmail($block ? '' : sanitize_email($state['customerEmail'] ?? ''))
                ->setPhone($block ? '' : sanitize_text_field($state['customerPhone'] ?? ''));
            if (!$customer->save()) { self::fail('db', 'Could not create customer.', 503); }
            $customers = array(array('id' => $customer->getId(), 'status' => $status,
                'number_of_persons' => 1, 'custom_fields' => array(), 'extras' => array(),
                'notes' => sanitize_textarea_field($state['notes'] ?? ''), 'payment_id' => null,
                'timezone' => 'Europe/Amsterdam'));
            $saved = \Bookly\Lib\Utils\Appointment::save(null, (int)ALLSTAR_BOOKLY_STAFF_ID, $service_id,
                $block ? 'Time off' : '', $block ? 0 : '', null, false, $start, $end, array(), array(),
                'current', $customers, false, 'All Star reference: ' . $input['localId'], 'backend');
            if (empty($saved['success']) || count($saved['appointments'] ?? array()) !== 1) { self::fail('save', 'Bookly did not save the appointment.', 503); }
            $appointment = \Bookly\Lib\Entities\Appointment::find($saved['appointments'][0]['id']);
            $participants = $appointment->getCustomerAppointments(true);
            $ca = reset($participants);
            if (!$ca || !$wpdb->insert($wpdb->prefix . 'allstar_bridge_links', array('local_id' => $input['localId'], 'appointment_id' => $appointment->getId(), 'ca_id' => $ca->getId(), 'kind' => $block ? 'block' : 'appointment', 'handling_minutes' => $state['handlingMinutes']))) { self::fail('db', 'Could not link appointment.', 503); }
        } else {
            $appointment->setStartDate($start)->setEndDate($end);
            if ($appointment->save() === false) { self::fail('db', 'Could not update appointment.', 503); }
            $ca->setStatus($status)->setNotes(sanitize_textarea_field($state['notes'] ?? ''));
            if ($ca->save() === false) { self::fail('db', 'Could not update participant.', 503); }
        }
        if ($wpdb->query($wpdb->prepare("UPDATE {$wpdb->prefix}allstar_bridge_links SET handling_minutes=%d WHERE local_id=%s", $state['handlingMinutes'], $input['localId'])) === false) { self::fail('db', 'Could not record buffer.', 503); }
        // The buffer is represented as extras_duration so Bookly's own slot
        // scheduler sees it. Never pretend Stripe receipts are Mollie receipts.
        $appointment->setExtrasDuration($state['handlingMinutes'] * 60);
        $appointment->setInternalNote('All Star reference: ' . $input['localId'] . "\nPayment: " . sanitize_text_field($state['paymentStatus'] ?? 'not applicable'));
        if ($appointment->save() === false) { self::fail('db', 'Could not save buffer.', 503); }
        foreach (self::rows() as $row) {
            if ((int)$row['ca_id'] === (int)$ca->getId()) {
                $remote = self::shape($row);
                return array('remoteId' => $remote['remoteId'], 'version' => $remote['version']);
            }
        }
        self::fail('db', 'Saved appointment missing from snapshot.', 503);
    }
}
register_activation_hook(__FILE__, array('AllStar_Bookly_Bridge', 'install'));
add_action('rest_api_init', array('AllStar_Bookly_Bridge', 'routes'));

add_filter('cron_schedules', array('AllStar_Bookly_Bridge', 'schedule'));
add_action('init', array('AllStar_Bookly_Bridge', 'initialize'));
add_action('allstar_bookly_sync', array('AllStar_Bookly_Bridge', 'tick'));
add_action('admin_init', array('AllStar_Bookly_Bridge', 'serializeNativeWrites'), -100);
register_deactivation_hook(__FILE__, function() { wp_clear_scheduled_hook('allstar_bookly_sync'); });

add_action('admin_menu', array('AllStar_Bookly_Bridge', 'adminMenu'));
