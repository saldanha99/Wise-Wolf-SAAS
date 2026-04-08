"use client";

import React, { useEffect, useRef, FC } from "react";
import { Renderer, Program, Mesh, Triangle, Vec3 } from "ogl";
import { cn } from "../lib/utils";

interface VoicePoweredOrbProps {
    className?: string;
    hue?: number;
    audioStream?: MediaStream | null; // NEW PROP
    voiceSensitivity?: number;
    maxRotationSpeed?: number;
    maxHoverIntensity?: number;
    state?: number;
    onVoiceDetected?: (detected: boolean) => void;
}

export const VoicePoweredOrb: FC<VoicePoweredOrbProps> = ({
    className,
    hue = 0,
    audioStream, // Destructure
    voiceSensitivity = 1.5,
    maxRotationSpeed = 1.2,
    maxHoverIntensity = 0.8,
    state = 0,
    onVoiceDetected,
}) => {
    const ctnDom = useRef<HTMLDivElement>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null); // Renamed from microphoneRef
    const dataArrayRef = useRef<Uint8Array | null>(null);
    const animationFrameRef = useRef<number>();

    const vert = /* glsl */ `
    precision highp float;
    attribute vec2 position;
    attribute vec2 uv;
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 0.0, 1.0);
    }
  `;

    const frag = /* glsl */ `
    precision highp float;

    uniform float iTime;
    uniform vec3 iResolution;
    uniform float hue;
    uniform float hover;
    uniform float rot;
    uniform float hoverIntensity;
    uniform float uState;
    varying vec2 vUv;

    vec3 rgb2yiq(vec3 c) {
      float y = dot(c, vec3(0.299, 0.587, 0.114));
      float i = dot(c, vec3(0.596, -0.274, -0.322));
      float q = dot(c, vec3(0.211, -0.523, 0.312));
      return vec3(y, i, q);
    }

    vec3 yiq2rgb(vec3 c) {
      float r = c.x + 0.956 * c.y + 0.621 * c.z;
      float g = c.x - 0.272 * c.y - 0.647 * c.z;
      float b = c.x - 1.106 * c.y + 1.703 * c.z;
      return vec3(r, g, b);
    }

    vec3 adjustHue(vec3 color, float hueDeg) {
      float hueRad = hueDeg * 3.14159265 / 180.0;
      vec3 yiq = rgb2yiq(color);
      float cosA = cos(hueRad);
      float sinA = sin(hueRad);
      float i = yiq.y * cosA - yiq.z * sinA;
      float q = yiq.y * sinA + yiq.z * cosA;
      yiq.y = i;
      yiq.z = q;
      return yiq2rgb(yiq);
    }

    vec3 hash33(vec3 p3) {
      p3 = fract(p3 * vec3(0.1031, 0.11369, 0.13787));
      p3 += dot(p3, p3.yxz + 19.19);
      return -1.0 + 2.0 * fract(vec3(
        p3.x + p3.y,
        p3.x + p3.z,
        p3.y + p3.z
      ) * p3.zyx);
    }

    float snoise3(vec3 p) {
      const float K1 = 0.333333333;
      const float K2 = 0.166666667;
      vec3 i = floor(p + (p.x + p.y + p.z) * K1);
      vec3 d0 = p - (i - (i.x + i.y + i.z) * K2);
      vec3 e = step(vec3(0.0), d0 - d0.yzx);
      vec3 i1 = e * (1.0 - e.zxy);
      vec3 i2 = 1.0 - e.zxy * (1.0 - e);
      vec3 d1 = d0 - (i1 - K2);
      vec3 d2 = d0 - (i2 - K1);
      vec3 d3 = d0 - 0.5;
      vec4 h = max(0.6 - vec4(
        dot(d0, d0),
        dot(d1, d1),
        dot(d2, d2),
        dot(d3, d3)
      ), 0.0);
      vec4 n = h * h * h * h * vec4(
        dot(d0, hash33(i)),
        dot(d1, hash33(i + i1)),
        dot(d2, hash33(i + i2)),
        dot(d3, hash33(i + 1.0))
      );
      return dot(vec4(31.316), n);
    }

    vec4 extractAlpha(vec3 colorIn) {
      float a = max(max(colorIn.r, colorIn.g), colorIn.b);
      return vec4(colorIn.rgb / (a + 1e-5), a);
    }

    const vec3 baseColor1 = vec3(0.611765, 0.262745, 0.996078);
    const vec3 baseColor2 = vec3(0.298039, 0.760784, 0.913725);
    const vec3 baseColor3 = vec3(0.062745, 0.078431, 0.600000);
    const float innerRadius = 0.6;
    const float noiseScale = 0.65;

    float light1(float intensity, float attenuation, float dist) {
      return intensity / (1.0 + dist * attenuation);
    }

    float light2(float intensity, float attenuation, float dist) {
      return intensity / (1.0 + dist * dist * attenuation);
    }

    vec4 draw(vec2 uv) {
      vec3 color1 = adjustHue(baseColor1, hue);
      vec3 color2 = adjustHue(baseColor2, hue);
      vec3 color3 = adjustHue(baseColor3, hue);

      float ang = atan(uv.y, uv.x);
      float len = length(uv);
      float invLen = len > 0.0 ? 1.0 / len : 0.0;

      float n0 = snoise3(vec3(uv * noiseScale, iTime * 0.5)) * 0.5 + 0.5;
      float r0 = mix(mix(innerRadius, 1.0, 0.4), mix(innerRadius, 1.0, 0.6), n0);
      float d0 = distance(uv, (r0 * invLen) * uv);
      float v0 = light1(1.0, 10.0, d0);
      v0 *= smoothstep(r0 * 1.05, r0, len);
      float cl = cos(ang + iTime * 2.0) * 0.5 + 0.5;

      float a = iTime * -1.0;
      vec2 pos = vec2(cos(a), sin(a)) * r0;
      float d = distance(uv, pos);
      float v1 = light2(1.5, 5.0, d);
      v1 *= light1(1.0, 50.0, d0);

      float v2 = smoothstep(1.0, mix(innerRadius, 1.0, n0 * 0.5), len);
      float v3 = smoothstep(innerRadius, mix(innerRadius, 1.0, 0.5), len);

      vec3 col = mix(color1, color2, cl);
      col = mix(color3, col, v0);
      col = (col + v1) * v2 * v3;
      col = clamp(col, 0.0, 1.0);

      return extractAlpha(col);
    }

    vec4 mainImage(vec2 fragCoord) {
      vec2 center = iResolution.xy * 0.5;
      float size = min(iResolution.x, iResolution.y);
      vec2 uv = (fragCoord - center) / size * 2.0;

      float angle = rot;
      float s = sin(angle);
      float c = cos(angle);
      uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);

      uv.x += hover * hoverIntensity * 0.1 * sin(uv.y * 10.0 + iTime);
      uv.y += hover * hoverIntensity * 0.1 * sin(uv.x * 10.0 + iTime);

      if (uState > 1.5) { // THINKING (2.0)
         uv *= 1.0 + 0.1 * sin(iTime * 5.0);
      }
      if (uState > 0.5 && uState < 1.5) { // LISTENING (1.0)
         uv *= 0.95 + 0.05 * cos(iTime * 10.0);
      }

      return draw(uv);
    }

    void main() {
      vec2 fragCoord = vUv * iResolution.xy;
      vec4 col = mainImage(fragCoord);
      gl_FragColor = vec4(col.rgb * col.a, col.a);
    }
  `;

    // 1. Initialize WebGL (Runs ONCE)
    useEffect(() => {
        const container = ctnDom.current;
        if (!container) return;

        // --- WebGL Setup ---
        const renderer = new Renderer({
            alpha: true,
            premultipliedAlpha: false,
            antialias: false,
            dpr: Math.min(window.devicePixelRatio || 1, 1.5)
        });
        const gl = renderer.gl;
        gl.clearColor(0, 0, 0, 0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        // Clear any existing canvas
        while (container.firstChild) {
            container.removeChild(container.firstChild);
        }
        container.appendChild(gl.canvas);

        const geometry = new Triangle(gl);
        const program = new Program(gl, {
            vertex: vert,
            fragment: frag,
            uniforms: {
                iTime: { value: 0 },
                iResolution: { value: new Vec3(gl.canvas.width, gl.canvas.height, gl.canvas.width / gl.canvas.height) },
                hue: { value: hue }, 
                hover: { value: 0 },
                rot: { value: 0 },
                hoverIntensity: { value: 0 },
                uState: { value: 0 }, // 0: IDLE, 1: LISTENING, 2: THINKING, 3: SPEAKING
            },
        });

        const mesh = new Mesh(gl, { geometry, program });

        // Store mutable state for the animation loop
        const state = {
            renderer,
            gl,
            mesh,
            program,
            rafId: 0,
            lastTime: 0,
            currentRot: 0,
        };

        // Resize Handler
        const resize = () => {
            const width = container.clientWidth;
            const height = container.clientHeight;
            if (width === 0 || height === 0) return;

            const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
            renderer.setSize(width * dpr, height * dpr);
            gl.canvas.style.width = width + "px";
            gl.canvas.style.height = height + "px";

            program.uniforms.iResolution.value.set(gl.canvas.width, gl.canvas.height, gl.canvas.width / gl.canvas.height);
        };
        window.addEventListener("resize", resize);
        resize();

        // Loop
        const update = (t: number) => {
            state.rafId = requestAnimationFrame(update);
            const dt = (t - state.lastTime) * 0.001;
            state.lastTime = t;

            // Read latest prop values from mutable ref (hack to avoid re-init)
            const currentHue = (ctnDom.current as any)?.__hue ?? 0;
            const currentState = (ctnDom.current as any)?.__state ?? 0;
            const hasStream = !!(ctnDom.current as any)?.__hasStream;

            program.uniforms.iTime.value = t * 0.001;
            program.uniforms.hue.value = currentHue;
            program.uniforms.uState.value = currentState;

            let voiceLevel = 0;
            if (hasStream && analyserRef.current && dataArrayRef.current) {
                analyserRef.current.getByteFrequencyData(dataArrayRef.current);

                let sum = 0;
                const len = dataArrayRef.current.length;
                for (let i = 0; i < len; i += 2) { // Skip bins for speed
                    const value = dataArrayRef.current[i];
                    sum += value * value;
                }
                const rms = Math.sqrt(sum / (len / 2)) / 255;
                voiceLevel = Math.min(rms * voiceSensitivity * 3.0, 1);

                // Notify parent component about voice detection
                if (onVoiceDetected) {
                    onVoiceDetected(voiceLevel > 0.05);
                }
            } else {
                if (onVoiceDetected) {
                    onVoiceDetected(false);
                }
            }

            if (voiceLevel > 0.01) { // Only apply rotation and hover if voice is detected
                const voiceRotationSpeed = 0.3 + (voiceLevel * maxRotationSpeed * 2.0);
                state.currentRot += dt * voiceRotationSpeed;
                program.uniforms.hover.value = Math.min(voiceLevel * 2.0, 1.0);
                program.uniforms.hoverIntensity.value = Math.min(voiceLevel * maxHoverIntensity * 0.8, maxHoverIntensity);
            } else {
                // Decay hover effects when no voice
                program.uniforms.hover.value *= 0.95;
                program.uniforms.hoverIntensity.value *= 0.95;
            }

            program.uniforms.rot.value = state.currentRot;

            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            renderer.render({ scene: mesh });
        };
        state.rafId = requestAnimationFrame(update);

        return () => {
            cancelAnimationFrame(state.rafId);
            window.removeEventListener("resize", resize);
            // Cleanup WebGL
            if (gl) {
                const extension = gl.getExtension('WEBGL_lose_context');
                if (extension) extension.loseContext();
                if (container.contains(gl.canvas)) container.removeChild(gl.canvas);
            }
        };
    }, [vert, frag, onVoiceDetected, voiceSensitivity, maxRotationSpeed, maxHoverIntensity]); // Only re-run if shaders change or relevant props change

    // 2. Handle Uniforms Updates via Refs (No Re-render of WebGL context)
    useEffect(() => {
        if (ctnDom.current) {
            (ctnDom.current as any).__hue = hue;
            (ctnDom.current as any).__hasStream = !!audioStream;
            (ctnDom.current as any).__state = state;
        }
    }, [hue, audioStream, state]);

    // 3. Audio Setup (Using external stream)
    useEffect(() => {
        if (!audioStream) {
            // Cleanup
            if (sourceRef.current) {
                sourceRef.current.disconnect();
                sourceRef.current = null;
            }
            if (analyserRef.current) {
                analyserRef.current.disconnect();
                analyserRef.current = null;
            }
            if (audioContextRef.current) {
                audioContextRef.current.close().catch(() => { });
                audioContextRef.current = null;
            }
            dataArrayRef.current = null;
            return;
        }

        // Initialize Context
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioContextRef.current = ctx;

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.5;
        analyserRef.current = analyser;

        const source = ctx.createMediaStreamSource(audioStream);
        source.connect(analyser);
        sourceRef.current = source;

        dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount);

        return () => {
            source.disconnect();
            analyser.disconnect();
            ctx.close().catch(() => { });
            sourceRef.current = null;
            analyserRef.current = null;
            audioContextRef.current = null;
            dataArrayRef.current = null;
        };
    }, [audioStream]);

    return (
        <div
            ref={ctnDom}
            className={cn(
                "w-full h-full relative",
                className
            )}
        >

        </div>
    );
};
