import React from 'react';

const SIGSelector = ({ sigs, selectedSigIds, onChange, className = '' }) => {
    const selected = new Set(selectedSigIds);
    const allSelected = sigs.length > 0 && selectedSigIds.length === sigs.length;

    const toggleSig = (sigId) => {
        onChange(
            selected.has(sigId)
                ? selectedSigIds.filter(id => id !== sigId)
                : [...selectedSigIds, sigId]
        );
    };

    return (
        <fieldset className={`min-w-0 ${className}`}>
            <legend className="text-sm text-gray-400">对比范围</legend>

            <div className="mb-2 mt-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-gray-500">
                    已选 {selectedSigIds.length} / {sigs.length} 个 SIG
                </span>
                <div className="flex shrink-0 gap-2">
                    <button
                        type="button"
                        onClick={() => onChange(sigs.map(sig => sig.id))}
                        disabled={allSelected}
                        className="rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-300 transition-colors hover:border-gray-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        全选
                    </button>
                    <button
                        type="button"
                        onClick={() => onChange([])}
                        disabled={selectedSigIds.length === 0}
                        className="rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-300 transition-colors hover:border-gray-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        清空
                    </button>
                </div>
            </div>

            <div className="flex max-h-24 flex-wrap gap-2 overflow-y-auto">
                {sigs.map(sig => (
                    <label
                        key={sig.id}
                        className="flex cursor-pointer items-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:border-gray-500 hover:text-white"
                    >
                        <input
                            type="checkbox"
                            className="h-4 w-4 accent-blue-600"
                            checked={selected.has(sig.id)}
                            onChange={() => toggleSig(sig.id)}
                        />
                        <span>{sig.name}</span>
                    </label>
                ))}
            </div>
        </fieldset>
    );
};

export default SIGSelector;
