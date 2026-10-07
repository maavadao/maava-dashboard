export function BrandMark() {
  return (
    <div className="flex items-center gap-3">
      <div className="grid h-10 w-10 place-items-center rounded-lg bg-gradient-to-br from-blue-600 to-blue-700 text-xs font-semibold text-white shadow-sm">
        <span className="font-heading tracking-[0.2em]">OC</span>
      </div>
      <div className="leading-tight">
        <div className="font-heading text-sm uppercase tracking-[0.26em] text-[color:var(--mc-text)]">
          OPENCLAW
        </div>
        <div className="text-[11px] font-medium text-[color:var(--mc-text-quiet)]">
          Mission Control
        </div>
      </div>
    </div>
  );
}
