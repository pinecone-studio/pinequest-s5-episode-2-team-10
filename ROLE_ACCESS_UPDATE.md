# Saylo-ийн эрхийн өөрчлөлт

Backend дээр `member` болон `admin` гэсэн role нэмэгдлээ.

## Юу өөрчлөгдөх вэ?

- Шинэ болон одоо байгаа хэрэглэгчид `member` эрхтэй байна.
- `member` зөвхөн өөрийн project, attempt, transcript, report, audio, slide-д хандана.
- `admin` бүх хэрэглэгчийн project болон attempt-ийг харах, өөрчлөх, устгах эрхтэй. Мөн хэрэглэгчдийн role болон идэвхтэй төлөвийг удирдаж болно.
- Хэрэглэгч бүртгүүлэхдээ өөрөө `admin` сонгож чадахгүй. Backend role-ийг шалгана.
- Өгөгдлийн санд `role`, `is_active` баганууд API асах үед нэмэгдэнэ. Supabase SQL Editor дээр SQL ажиллуулах, хүснэгт устгах шаардлагагүй.

## Admin тохируулах

Итгэмжлэгдсэн Google account-ын email-үүдийг API серверийн private environment дотор таслалаар тусгаарлан `PITCH_ADMIN_EMAILS`-д бичээд backend-ээ дахин асаана:

```env
PITCH_ADMIN_EMAILS=admin@example.com,teammate@example.com
```

Жагсаалтад орсон хүн яг тэр email-тэй Google account-аар нэвтэрсний дараа `admin` болно. Багийн өөр гишүүнийг admin болгохдоо email-ийг таслалаар нэмж, backend-ээ restart хийнэ. Бодит email-үүдээ `.env.example` болон Git-д оруулахгүй.

Тохируулсан admin-ийг API-аар бууруулах боломжгүй. Тэр хүний email-ийг эхлээд `PITCH_ADMIN_EMAILS`-ээс авч backend-ээ restart хийгээд, өөр admin-аар тухайн хэрэглэгчийн role-ийг солино. Admin өөрийн role эсвэл төлөвийг өөрчлөх боломжгүй; сүүлийн идэвхтэй admin-ийг бууруулах/идэвхгүй болгохыг backend хориглоно.

## Admin API

Admin account-ын `X-Access-Token` ашиглан FastAPI-ийн `/docs` хуудаснаас:

- `GET /api/v1/admin/users` — хэрэглэгчдийн email, role, идэвхтэй төлөв, бүртгүүлсэн огноог харна.
- `PATCH /api/v1/admin/users/{user_id}` — `{"role":"admin"}`, `{"role":"member"}`, `{"is_active":false}` эсвэл `{"is_active":true}` илгээнэ.

Эдгээр нь backend API; одоогоор тусдаа admin дэлгэц frontend-д нэмээгүй. Хэрэглэгчийг идэвхгүй болгоход түүний нэвтрэх token-ууд хүчингүй болж, дахин идэвхжүүлсний дараа хэрэглэгч шинээр нэвтрэх шаардлагатай.

## Нууцлал

`admin` нь өндөр эрхтэй: бусдын pitch, transcript, audio, slide зэрэг хувийн өгөгдлийг харах, өөрчлөх, устгах боломжтой. Шаардлагатай, итгэлтэй хүмүүст л admin эрх өгнө. Supabase-ийн `authenticated` төлөв нь Saylo-ийн `member/admin` role-оос тусдаа.

Код татсаны дараа backend-ээ restart хийгээд `/auth/me`-ийн `role`-ийг шалгаарай. Одоо байгаа хэрэглэгчдийн өгөгдөл хэвээр үлдэнэ; schema update автоматаар, нэмэлтээр хийгдэнэ.
