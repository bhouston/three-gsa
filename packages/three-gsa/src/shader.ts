// Derived from the EA FAST WebGPU port; see THIRD_PARTY_NOTICES.md.
// The fixed research profile is preserved, including the truncated mixed kernel.
export function createShader(S: number, Z: number, fs: number, workgroupX: number, workgroupY: number): string {
 const bits = Math.log2(S);
 return `
struct Params { key: vec4u, iteration: u32, suppression: u32, numTaps: u32, pad: u32 }
@group( 0 ) @binding( 0 ) var<storage, read_write> values: array<f32>;
@group( 0 ) @binding( 1 ) var<storage, read_write> delta: array<f32>;
@group( 0 ) @binding( 2 ) var<storage, read> taps: array<vec4f>;
@group( 0 ) @binding( 3 ) var<storage, read> W: array<f32>;
@group( 0 ) @binding( 4 ) var<uniform> params: Params;
@group( 0 ) @binding( 5 ) var<storage, read_write> swaps: atomic<u32>;

const S = ${S}u; const Z = ${Z}u; const FS = ${fs}; const BITS = ${bits}u;

fn wang_hash_init( s: vec3u ) -> u32 { return ( s.x * 1973u + s.y * 9277u + s.z * 26699u ) | 1u; }
fn wang_hash_uint( seed_in: u32 ) -> u32 {
	var seed = ( seed_in ^ 61u ) ^ ( seed_in >> 16u );
	seed *= 9u; seed = seed ^ ( seed >> 4u ); seed *= 0x27d4eb2du; seed = seed ^ ( seed >> 15u );
	return seed;
}
fn roundFunction( subkey: u32, r: u32 ) -> u32 { return wang_hash_uint( subkey ^ r ); }
fn getOtherIndex( index: vec3u, key_in: vec4u ) -> vec3u {
	let mask = ( 1u << BITS ) - 1u;
	var lr = index.xy & vec2u( mask );
	let highIndex = index.xy & vec2u( ~mask );
	let key = key_in ^ vec4u( index.z ) ^ highIndex.xyxy;
	lr = lr.yx ^ vec2u( 0u, roundFunction( key.x, lr.y ) & mask );
	lr = lr.yx ^ vec2u( 0u, roundFunction( key.y, lr.y ) & mask );
	lr = lr.yx ^ vec2u( 0u, roundFunction( key.z, lr.y ) & mask );
	lr ^= vec2u( key.w >> BITS, key.w ) & vec2u( mask );
	lr = lr.yx ^ vec2u( roundFunction( key.z, lr.x ) & mask, 0u );
	lr = lr.yx ^ vec2u( roundFunction( key.y, lr.x ) & mask, 0u );
	lr = lr.yx ^ vec2u( roundFunction( key.x, lr.x ) & mask, 0u );
	return vec3u( index.xy, index.z ^ ( wang_hash_uint( key_in.x ^ index.x ^ ( index.y * 1973u ) ) & ( Z - 1u ) ) );
}
fn flat( p: vec3u ) -> u32 { return ( p.z * S + p.y ) * S + p.x; }
fn K2( a: f32, b: f32 ) -> f32 { let d = a - b; return - abs( d ) - 0.25000000 * d * d - 0.00000000 * ( 1.0 - cos( 6.28318530718 * d ) ); }
fn weight( d: vec3i ) -> f32 {
	if ( abs( d.x ) > FS || abs( d.y ) > FS ) { return 0.0; }
	return W[ ( u32( d.x + FS ) * u32( 2 * FS + 1 ) + u32( d.y + FS ) ) * Z + u32( d.z ) ];
}

@compute @workgroup_size( ${workgroupX}, ${workgroupY}, 1 )
fn loss( @builtin( global_invocation_id ) id: vec3u ) {
	let c = values[ flat( id ) ];
	let other = getOtherIndex( id, params.key );
	let o = values[ flat( other ) ];
	var d = 0.0;
	for ( var t = 0u; t < params.numTaps; t ++ ) {
		let tap = taps[ t ];
		let p = vec3u( ( vec3i( id ) + vec3i( tap.xyz ) + vec3i( i32( S ), i32( S ), i32( Z ) ) ) % vec3i( i32( S ), i32( S ), i32( Z ) ) );
		let n = values[ flat( p ) ];
		d += tap.w * ( K2( o, n ) - K2( c, n ) );
	}
	let diff = vec3i( id ) - vec3i( other );
	let s = vec3i( i32( S ), i32( S ), i32( Z ) );
	let dij = min( abs( diff ), min( abs( diff - s ), abs( diff + s ) ) );
	d += ( weight( dij ) - weight( vec3i( 0 ) ) ) * K2( c, o );
	delta[ flat( id ) ] = d;
}

@compute @workgroup_size( ${workgroupX}, ${workgroupY}, 1 )
fn swap( @builtin( global_invocation_id ) id: vec3u ) {
	let other = getOtherIndex( id, params.key );
	let i = flat( id ); let j = flat( other );
	let l = delta[ i ] + delta[ j ];
	let r = wang_hash_uint( wang_hash_init( id + vec3u( params.iteration ) ) );
	let temperature = 0.00100000 * max( 0.0, 1.0 - f32( params.iteration ) / 1500.0 );
	let bound = - temperature * log( max( 0.0000001, f32( wang_hash_uint( r ^ 29389741u ) ) / 4294967296.0 ) );
	if ( i < j && l < bound && ( r % max( params.suppression, 2u ) ) == 0u ) {
		let v = values[ i ]; values[ i ] = values[ j ]; values[ j ] = v;
		atomicAdd( &swaps, 1u );
	}
}`;
}
