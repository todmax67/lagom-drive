import React from 'react';
type NavButtonProps = {
  icon: React.ReactNode;
  label: string;
  isActive: boolean;
  onClick: () => void;
  disabled?: boolean;
};

export default function NavButton({
  icon,
  label,
  isActive,
  onClick,
  disabled = false,
}: NavButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={`
        relative p-3 rounded-xl transition-all duration-200 flex flex-col items-center gap-1
        ${isActive
          ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/25'
          : 'text-gray-400 hover:text-white hover:bg-gray-700/50'
        }
        ${disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'}
      `}
    >
      {icon}
      <span className="text-[10px] font-medium tracking-wide hidden sm:block">
        {label}
      </span>
    </button>
  );
}