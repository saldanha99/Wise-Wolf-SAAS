import React from 'react';

interface EnrollmentProRataSwitchProps {
    checked: boolean;
    disabled?: boolean;
    label: string;
    onCheckedChange: (checked: boolean) => void;
}

const EnrollmentProRataSwitch: React.FC<EnrollmentProRataSwitchProps> = ({
    checked,
    disabled = false,
    label,
    onCheckedChange,
}) => (
    <label
        className={`relative inline-flex h-11 w-11 shrink-0 items-center ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
    >
        <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={event => {
                if (!disabled) onCheckedChange(event.target.checked);
            }}
            className="peer sr-only"
            aria-label={label}
        />
        <span
            aria-hidden="true"
            className="absolute left-0.5 top-2.5 h-6 w-10 rounded-full bg-slate-200 transition-colors peer-checked:bg-amber-500 peer-focus-visible:ring-2 peer-focus-visible:ring-amber-500 peer-focus-visible:ring-offset-2 dark:bg-slate-700"
        />
        <span
            aria-hidden="true"
            className="absolute left-1.5 top-3.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4"
        />
    </label>
);

export default EnrollmentProRataSwitch;
