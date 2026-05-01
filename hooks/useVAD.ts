import { useEffect, useRef } from 'react';

interface VADCallbacks {
    onSpeechStart: () => void;
    onSpeechEnd: () => void;
}

export function useVAD(stream: MediaStream | null, enabled: boolean, callbacks: VADCallbacks) {
    const cbRef = useRef(callbacks);
    cbRef.current = callbacks;

    useEffect(() => {
        if (!stream || !enabled) return;
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.3;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        let speaking = false;
        let lastVoiceTs = 0;
        const SILENCE_MS = 800;
        const VOLUME_THRESHOLD = 22;
        let raf = 0;

        const tick = () => {
            analyser.getByteFrequencyData(data);
            const avg = data.reduce((a, b) => a + b, 0) / data.length;
            const now = performance.now();

            if (avg > VOLUME_THRESHOLD) {
                lastVoiceTs = now;
                if (!speaking) { speaking = true; cbRef.current.onSpeechStart(); }
            } else if (speaking && now - lastVoiceTs > SILENCE_MS) {
                speaking = false;
                cbRef.current.onSpeechEnd();
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);

        return () => { cancelAnimationFrame(raf); ctx.close(); };
    }, [stream, enabled]);
}
