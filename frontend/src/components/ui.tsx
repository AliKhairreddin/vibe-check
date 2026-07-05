import React from 'react';
export const Card=({children}:{children:React.ReactNode})=><section className="card">{children}</section>;
export const Button=(p:React.ButtonHTMLAttributes<HTMLButtonElement>)=><button {...p} className={`btn ${p.className||''}`}/>;
export const Badge=({children}:{children:React.ReactNode})=><span className="badge">{children}</span>;
export const Textarea=(p:React.TextareaHTMLAttributes<HTMLTextAreaElement>)=><textarea {...p} className="input min-h-28"/>;
export const Input=(p:React.InputHTMLAttributes<HTMLInputElement>)=><input {...p} className="input"/>;
