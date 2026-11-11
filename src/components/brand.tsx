/** Símbolo da Tess redesenhado a partir do arquivo oficial: quatro blocos em cata-vento (frame 520×520). */
const MARK =
  'M100 0 H144 C151.7 0 158 6.3 158 14 V160 C158 238.4 107.4 302 45 302 H10 C4.5 302 0 297.5 0 292 V88 C0 39.4 44.8 0 100 0 Z ' +
  'M298 0 H370 C452.8 0 520 76.1 520 170 V184 C520 190.6 514.6 196 508 196 H288 C232.8 196 188 153 188 100 V100 C188 44.8 237.2 0 298 0 Z ' +
  'M420 520 H376 C368.3 520 362 513.7 362 506 V360 C362 281.6 412.6 218 475 218 H510 C515.5 218 520 222.5 520 228 V432 C520 480.6 475.2 520 420 520 Z ' +
  'M222 520 H150 C67.2 520 0 443.9 0 350 V336 C0 329.4 5.4 324 12 324 H232 C287.2 324 332 367 332 420 V420 C332 475.2 282.8 520 222 520 Z';

/** Monocromático: herda a cor do texto, preto no tema claro e branco no escuro. */
export function TessMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 520 520" width={size} height={size} className={className} fill="currentColor" aria-hidden>
      <path d={MARK} />
    </svg>
  );
}

export function Wordmark({ size = 22, className = '' }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center text-fg ${className}`} style={{ gap: size * 0.34 }} aria-label="tess">
      <TessMark size={size} />
      <span className="font-normal leading-none tracking-[-0.035em]" style={{ fontSize: size * 1.18, marginTop: -size * 0.12 }} aria-hidden>
        tess
      </span>
    </span>
  );
}

/** Avatar da assistente nas mensagens. */
export function TessAvatar({ size = 26 }: { size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-lg bg-fg text-bg" style={{ width: size, height: size }}>
      <TessMark size={size * 0.58} />
    </span>
  );
}
