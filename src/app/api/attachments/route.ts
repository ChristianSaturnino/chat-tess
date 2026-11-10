import { NextResponse } from 'next/server';
import { AppError } from '@/server/errors';
import { assertSameOrigin, requireUser, route } from '@/server/http';
import { MAX_ATTACHMENT_BYTES, uploadAttachment } from '@/server/storage/attachments';

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_ATTACHMENT_BYTES + 64 * 1024) throw new AppError(413, 'file_too_large', 'arquivo maior que 10 MB');
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new AppError(400, 'no_file', 'campo "file" ausente');
  const row = await uploadAttachment(user.id, file.name, Buffer.from(await file.arrayBuffer()));
  return NextResponse.json(
    { attachment: { id: row.id, filename: row.filename, mimeType: row.mimeType, sizeBytes: row.sizeBytes } },
    { status: 201 },
  );
});
