/**
 * Softens WebXR environment depth occlusion edges by replacing Three.js's default
 * depth prepass fragment shader with a Gaussian blur in depth texture space.
 */

/** Bump when shader changes so existing patched materials get replaced. */
export const XR_DEPTH_FEATHER_PATCH_VERSION = 2;

const FEATHER_FRAGMENT = /* glsl */ `
uniform sampler2DArray depthColor;
uniform float depthWidth;
uniform float depthHeight;
uniform float uFeatherPx;

const float ROW5[5] = float[]( 1.0, 4.0, 6.0, 4.0, 1.0 );

float sampleDepth( vec2 uv, float layer ) {
	return texture( depthColor, vec3( uv, layer ) ).r;
}

float featheredDepth( vec2 uv, float layer ) {
	vec2 t = vec2( 1.0 / depthWidth, 1.0 / depthHeight ) * uFeatherPx;
	float sum = 0.0;
	for ( int j = 0; j < 5; j++ ) {
		for ( int i = 0; i < 5; i++ ) {
			vec2 o = vec2( float( i - 2 ), float( j - 2 ) ) * t;
			float w = ROW5[i] * ROW5[j] / 256.0;
			sum += sampleDepth( clamp( uv + o, vec2( 0.0 ), vec2( 1.0 ) ), layer ) * w;
		}
	}
	return sum;
}

void main() {
	vec2 coord = vec2( gl_FragCoord.x / depthWidth, gl_FragCoord.y / depthHeight );
	if ( coord.x >= 1.0 ) {
		vec2 uv = vec2( coord.x - 1.0, coord.y );
		gl_FragDepth = featheredDepth( uv, 1.0 );
	} else {
		vec2 uv = vec2( coord.x, coord.y );
		gl_FragDepth = featheredDepth( uv, 0.0 );
	}
}
`;

/**
 * @param {import("three").WebGLRenderer} renderer
 * @param {number} [featherPx=6] Blur step in depth-texel units (5×5 kernel spans ~4× this many texels; higher = softer edges).
 */
export function patchWebXRDepthSensingMeshIfNeeded(renderer, featherPx = 6) {
  if (!renderer?.xr?.hasDepthSensing?.()) return;
  const mesh = renderer.xr.getDepthSensingMesh();
  if (!mesh?.material) return;
  const m = mesh.material;
  if (m.userData.sketcharDepthFeather === XR_DEPTH_FEATHER_PATCH_VERSION) return;
  m.userData.sketcharDepthFeather = XR_DEPTH_FEATHER_PATCH_VERSION;
  m.fragmentShader = FEATHER_FRAGMENT;
  if (!m.uniforms.uFeatherPx) m.uniforms.uFeatherPx = { value: featherPx };
  else m.uniforms.uFeatherPx.value = featherPx;
  m.needsUpdate = true;
}
