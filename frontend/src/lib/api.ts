export type Status={job_id:string;status:string;progress:number;message:string;report_ready:boolean};
export type Report={overall_status:string;summary:string;findings:any[];safe_rewrite:{ad_copy:string;onscreen_text:string[]};limitations:string[]};
export async function createReview(form:FormData):Promise<Status>{const r=await fetch('/api/reviews',{method:'POST',body:form}); if(!r.ok) throw new Error(await r.text()); return r.json()}
export async function getStatus(id:string):Promise<Status>{const r=await fetch(`/api/reviews/${id}`); if(!r.ok) throw new Error(await r.text()); return r.json()}
export async function getReport(id:string):Promise<Report>{const r=await fetch(`/api/reviews/${id}/report`); if(!r.ok) throw new Error(await r.text()); return r.json()}
