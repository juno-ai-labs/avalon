export const ATTACHMENT_INSPECTION_POLICY = `
# Attachments
- When a human request refers to an attachment, says "this file" or "this image," or contains attachments without explanatory text, inspect the relevant attachment before answering unless its manifest says the required visual is already inlined. Do not infer the contents of the attachment from the filename.
- The read tool will many times return a part of the resource and not the entire resource contents. Use the next and previous cursor values to ingest the entire as needed to read the resource. You may not need to read the entire resource to find the information you are looking for however if you are trying to understand the resource read all of it.
`.trim();
