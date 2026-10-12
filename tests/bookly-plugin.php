<?php
// Isolated protocol tests. Real Bookly/MySQL concurrency is a staging check.
namespace Bookly\Lib\Utils { class Appointment { public static $checks = array(); public static function checkTime(...$args) { return self::$checks; } } }
namespace BooklyPro\Lib { class Plugin {} }
namespace {
define('ABSPATH', '/tmp/'); define('DAY_IN_SECONDS', 86400);
define('ALLSTAR_BOOKLY_SECRET', str_repeat('x',40)); define('ALLSTAR_BOOKLY_STAFF_ID',5); define('ALLSTAR_BOOKLY_SERVICES',array('haircut'=>1));
class WP_Error { public $code,$message,$data; public function __construct($c,$m,$d){$this->code=$c;$this->message=$m;$this->data=$d;} }
class WP_REST_Response { public $data,$headers=array(); public function __construct($d){$this->data=$d;} public function header($k,$v){$this->headers[$k]=$v;} }
class TestRequest {
 public $headers=array(),$body,$route;
 public function __construct($route,$input){$this->route='/allstar-bookly/v1/'.$route;$this->body=json_encode($input);$this->headers=array('x-allstar-timestamp'=>(string)time(),'x-allstar-nonce'=>'12345678-1234-1234-1234-123456789abc');$this->sign();}
 public function sign(){$this->headers['x-allstar-signature']=hash_hmac('sha256',$this->headers['x-allstar-timestamp']."\n".$this->headers['x-allstar-nonce']."\n".$this->route."\n".$this->body,ALLSTAR_BOOKLY_SECRET);}
 public function get_header($key){return $this->headers[$key]??'';} public function get_body(){return $this->body;} public function get_route(){return $this->route;} public function get_json_params(){return json_decode($this->body,true);}
}
class FakeDatabase {
 public $prefix='wp_', $last_error='', $nonces=array(),$commands=array(),$queries=array(),$busy=null;
 public function prepare($sql,...$args){foreach($args as $a){$sql=preg_replace('/%[sd]/',is_int($a)?(string)$a:"'".addslashes($a)."'",$sql,1);}return $sql;}
 public function query($sql){$this->queries[]=$sql;return 1;}
 public function insert($table,$data){if(str_ends_with($table,'nonces')){if(isset($this->nonces[$data['nonce']]))return false;$this->nonces[$data['nonce']]=true;}if(str_ends_with($table,'commands'))$this->commands[$data['id']]=$data;return 1;}
 public function get_var($sql){$this->queries[]=$sql;if(str_contains($sql,'information_schema'))return 'InnoDB';if(str_contains($sql,'GET_LOCK')||str_contains($sql,'RELEASE_LOCK'))return 1;return $this->busy;}
 public function get_row($sql,$format){if(str_contains($sql,'allstar_bridge_commands')&&preg_match("/id = '([^']+)'/",$sql,$m))return $this->commands[$m[1]]??null;return null;}
 public function get_results($sql,$format){return array();}
}
$wpdb=new FakeDatabase();
function register_activation_hook(...$args){} function register_deactivation_hook(...$args){} function add_action(...$args){} function add_filter(...$args){}
function get_option($name){return $name==='timezone_string'?'Europe/Amsterdam':null;} function wp_json_encode($v){return json_encode($v);}
function wp_date($format,$time){return date($format,$time);} function sanitize_text_field($v){return $v;} function sanitize_textarea_field($v){return $v;} function sanitize_email($v){return $v;}
define('ARRAY_A','ARRAY_A');
require __DIR__.'/../integrations/bookly/allstar-bookly-bridge/allstar-bookly-bridge.php';
function check($condition,$message){if(!$condition)throw new \RuntimeException($message);}
$unsigned=new TestRequest('snapshot',array());$unsigned->headers['x-allstar-signature']='bad';check(AllStar_Bookly_Bridge::authorize($unsigned)->data['status']===403,'invalid signature');
$stale=new TestRequest('snapshot',array());$stale->headers['x-allstar-timestamp']=(string)(time()-300);$stale->sign();check(AllStar_Bookly_Bridge::authorize($stale)->data['status']===403,'expired request');
$signed=new TestRequest('snapshot',array());check(AllStar_Bookly_Bridge::authorize($signed)===true,'valid signed request');check(AllStar_Bookly_Bridge::authorize($signed)->data['status']===403,'nonce replay');
$command=new TestRequest('command',array('id'=>'cmd-1','localId'=>'removed-1','kind'=>'appointment','state'=>array('status'=>'cancelled')));
$result=AllStar_Bookly_Bridge::command($command);check($result instanceof WP_REST_Response && $result->data['terminal']===true,'terminal unlinked command');
$replayed=AllStar_Bookly_Bridge::command($command);check($replayed->data===$result->data,'identical command replay');
$changed=new TestRequest('command',array('id'=>'cmd-1','localId'=>'different','state'=>array('status'=>'cancelled')));check(AllStar_Bookly_Bridge::command($changed)->data['status']===409,'different payload same command ID');
check(count($wpdb->commands)===1,'no duplicate command records');
$free=new ReflectionMethod('AllStar_Bookly_Bridge','free');
\Bookly\Lib\Utils\Appointment::$checks=array('interval_not_in_staff_schedule'=>true);
check($free->invoke(null,'2026-11-03','10:00',40,1)===false,'staff schedule blocks invalid slots');
check($free->invoke(null,'2026-11-03','10:00',540,null)===true,'full day block is not refused for intersecting staff breaks');
\Bookly\Lib\Utils\Appointment::$checks=array();$wpdb->busy=99;
check($free->invoke(null,'2026-11-03','10:00',40,1)===false,'active overlap blocks booking');
check(str_contains(end($wpdb->queries),"NOT IN ('cancelled','rejected','waitlisted')"),'terminal participants do not occupy time');
echo "PASS: PHP syntax/runtime, HMAC expiry and replay, idempotent commands, altered-payload refusal, staff schedule and full-day blocks\n";
}
