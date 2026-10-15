import React from 'react';

/**
 * The app's brand mark: a blue tile with a play triangle over text lines
 * ("video → notes"). This is the single source of truth for the mark in the
 * UI — keep it in sync with public/favicon.svg and the raster icons
 * (favicon-*.png / apple-touch-icon.png) generated from the same geometry.
 */
export const BrandMark: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
    <rect width="64" height="64" rx="16" fill="#2563eb" />
    <path d="M25 15L25 32L39 23.5Z" fill="#ffffff" />
    <path d="M19.5 38.5H44.5" stroke="#ffffff" strokeWidth="4.5" strokeLinecap="round" />
    <path d="M19.5 47H33" stroke="#ffffff" strokeWidth="4.5" strokeLinecap="round" />
  </svg>
);
