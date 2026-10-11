/* QOI format: Dominic Szablewski, https://github.com/phoboslab/qoi (MIT).
 * This allocation-free implementation adds independent damage tiles.
 * Pixel data is lossless RGBA throughout; no YUV conversion or subsampling.
 */
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef u32 u32x4 __attribute__((vector_size(16),aligned(4)));
typedef __UINTPTR_TYPE__ ptr;
#ifdef __wasm32__
#define QOI_TLS
void *memset(void *destination, int value, u32 length){
  u8 *p=(u8*)destination;for(u32 i=0;i<length;i++)p[i]=(u8)value;return destination;
}
extern u8 __heap_base;
#define BASE ((ptr)&__heap_base)
#else
#define QOI_TLS thread_local
static thread_local u8 *native_heap;
#define BASE ((ptr)native_heap)
#endif
static QOI_TLS u32 width, height, capacity;
static QOI_TLS ptr input, previous, output;
static QOI_TLS int initialized;
#define TILE_W 128
#define TILE_H 64
static void le16(u8 *p,u32 v){p[0]=v;p[1]=v>>8;}
static void le32(u8 *p,u32 v){p[0]=v;p[1]=v>>8;p[2]=v>>16;p[3]=v>>24;}
static u32 be32(const u8*p){return ((u32)p[0]<<24)|((u32)p[1]<<16)|((u32)p[2]<<8)|p[3];}
static void putbe(u8*p,u32 v){p[0]=v>>24;p[1]=v>>16;p[2]=v>>8;p[3]=v;}
static u32 hash(u32 p){return ((p&255)*3+((p>>8)&255)*5+((p>>16)&255)*7+(p>>24)*11)&63;}
ptr heap_base(void){return BASE;}
ptr configure(u32 w,u32 h){
  if(!w||!h||w>8192||h>4320)return 0;
  width=w;height=h;input=(BASE+15)&~(ptr)15;
  previous=input+w*h*4;output=previous+w*h*4;
  capacity=w*h*5+((w+127)/128)*((h+63)/64)*40+64;
  initialized=0;return output+capacity;
}
ptr input_pointer(void){return input;}
ptr output_pointer(void){return output;}
static u32 encode_tile(u8*out,u32 x,u32 y,u32 w,u32 h){
  u32 index[64]={0};u32 prev=0xff000000,run=0,n=14;
  out[0]='q';out[1]='o';out[2]='i';out[3]='f';putbe(out+4,w);putbe(out+8,h);out[12]=4;out[13]=0;
  for(u32 row=0;row<h;row++)for(u32 col=0;col<w;col++){
    u32 offset=((y+row)*width+x+col)*4;
    u32 p=*(u32*)(input+offset);*(u32*)(previous+offset)=p;
    if(p==prev){
      run++;if(run==62||(row==h-1&&col==w-1)){out[n++]=0xc0|(run-1);run=0;}
    }else{
      if(run){out[n++]=0xc0|(run-1);run=0;}
      u32 hi=hash(p);
      if(index[hi]==p)out[n++]=hi;
      else{
        index[hi]=p;
        if((p>>24)==(prev>>24)){
          int dr=(int)(p&255)-(int)(prev&255),dg=(int)((p>>8)&255)-(int)((prev>>8)&255),db=(int)((p>>16)&255)-(int)((prev>>16)&255);
          int rg=dr-dg,bg=db-dg;
          if(dr>=-2&&dr<=1&&dg>=-2&&dg<=1&&db>=-2&&db<=1)out[n++]=0x40|((dr+2)<<4)|((dg+2)<<2)|(db+2);
          else if(dg>=-32&&dg<=31&&rg>=-8&&rg<=7&&bg>=-8&&bg<=7){out[n++]=0x80|(dg+32);out[n++]=((rg+8)<<4)|(bg+8);}
          else{out[n++]=0xfe;out[n++]=p;out[n++]=p>>8;out[n++]=p>>16;}
        }else{out[n++]=0xff;out[n++]=p;out[n++]=p>>8;out[n++]=p>>16;out[n++]=p>>24;}
      }
    }
    prev=p;
  }
  for(int i=0;i<7;i++)out[n++]=0;out[n++]=1;return n;
}
u32 encode_frame(u32 force,u32 sequence){
  if(!width||!height)return 0;
  u8 *out=(u8*)output;u32 n=32,count=0;
  le32(out,0x314f5147);le32(out+4,sequence);le16(out+8,width);le16(out+10,height);
  le16(out+14,force||!initialized);
  for(u32 y=0;y<height;y+=TILE_H)for(u32 x=0;x<width;x+=TILE_W){
    u32 w=width-x<TILE_W?width-x:TILE_W,h=height-y<TILE_H?height-y:TILE_H;
    int dirty=force||!initialized;
    if(!dirty)for(u32 row=0;row<h&&!dirty;row++){
      u32 pos=((y+row)*width+x)*4;
      u32 *a=(u32*)(input+pos),*b=(u32*)(previous+pos);
      u32 col=0;
      for(;col+4<=w;col+=4){u32x4 d=*(u32x4*)(a+col)^*(u32x4*)(b+col);if(d[0]|d[1]|d[2]|d[3]){dirty=1;break;}}
      if(!dirty)for(;col<w;col++)if(a[col]!=b[col]){dirty=1;break;}
    }
    if(!dirty)continue;
    le16(out+n,x);le16(out+n+2,y);le16(out+n+4,w);le16(out+n+6,h);
    u32 len=encode_tile(out+n+12,x,y,w,h);le32(out+n+8,len);n+=12+len;count++;
  }
  initialized=1;le16(out+12,count);return count?n:0;
}
u32 decode_tile(ptr src,u32 length,ptr dest,u32 w,u32 h){
  if(length<22||!w||!h||w>128||h>64)return 0;
  u8 *p=(u8*)src;u32 *out=(u32*)dest;
  if(p[0]!='q'||p[1]!='o'||p[2]!='i'||p[3]!='f'||be32(p+4)!=w||be32(p+8)!=h||p[12]!=4)return 0;
  u32 index[64]={0},pixel=0xff000000,n=14,run=0;
  for(u32 i=0;i<w*h;i++){
    if(run)run--;
    else{
      if(n>=length-8)return 0;u32 b=p[n++];
      u32 r=pixel&255,g=(pixel>>8)&255,bl=(pixel>>16)&255,a=pixel>>24;
      if(b==0xfe){if(n+3>length-8)return 0;r=p[n++];g=p[n++];bl=p[n++];}
      else if(b==0xff){if(n+4>length-8)return 0;r=p[n++];g=p[n++];bl=p[n++];a=p[n++];}
      else if((b&0xc0)==0){pixel=index[b];r=pixel&255;g=(pixel>>8)&255;bl=(pixel>>16)&255;a=pixel>>24;}
      else if((b&0xc0)==0x40){r=(r+((b>>4)&3)-2)&255;g=(g+((b>>2)&3)-2)&255;bl=(bl+(b&3)-2)&255;}
      else if((b&0xc0)==0x80){if(n>=length-8)return 0;u32 b2=p[n++];int dg=(b&63)-32;r=(r+dg+(b2>>4)-8)&255;g=(g+dg)&255;bl=(bl+dg+(b2&15)-8)&255;}
      else {
        u32 count=(b&63)+1;
        if(i+count>w*h)return 0;
        u32x4 repeated={pixel,pixel,pixel,pixel};u32 j=0;
        for(;j+4<=count;j+=4)*(u32x4*)(out+i+j)=repeated;
        for(;j<count;j++)out[i+j]=pixel;
        index[hash(pixel)]=pixel;i+=count-1;continue;
      }
      pixel=r|(g<<8)|(bl<<16)|(a<<24);index[hash(pixel)]=pixel;
    }
    out[i]=pixel;
  }
  return w*h*4;
}
static u32 readle16(const u8*p){return p[0]|((u32)p[1]<<8);}
static u32 readle32(const u8*p){return readle16(p)|(readle16(p+2)<<16);}
static QOI_TLS u32 dx,dy,dw,dh;
u32 damage_x(void){return dx;}u32 damage_y(void){return dy;}
u32 damage_width(void){return dw;}u32 damage_height(void){return dh;}
// Decode the complete packet in WASM: one input copy, no JS row-by-row copies.
u32 decode_packet(ptr source,u32 length,ptr raster,ptr scratch,u32 w,u32 h){
  const u8*p=(const u8*)source;if(length<32||readle32(p)!=0x314f5147||readle16(p+8)!=w||readle16(p+10)!=h)return 0;
  u32 count=readle16(p+12),offset=32,mx=0,my=0;dx=w;dy=h;
  for(u32 tile=0;tile<count;tile++){
    if(offset+12>length)return 0;
    u32 x=readle16(p+offset),y=readle16(p+offset+2),tw=readle16(p+offset+4),th=readle16(p+offset+6),n=readle32(p+offset+8);offset+=12;
    if(!tw||!th||tw>128||th>64||x+tw>w||y+th>h||n>49152||n>length-offset)return 0;
    if(decode_tile(source+offset,n,scratch,tw,th)!=tw*th*4)return 0;
    for(u32 row=0;row<th;row++){
      u32*a=(u32*)(scratch+row*tw*4),*b=(u32*)(raster+((y+row)*w+x)*4),j=0;
      for(;j+4<=tw;j+=4)*(u32x4*)(b+j)=*(u32x4*)(a+j);
      for(;j<tw;j++)b[j]=a[j];
    }
    if(x<dx)dx=x;if(y<dy)dy=y;if(x+tw>mx)mx=x+tw;if(y+th>my)my=y+th;
    offset+=n;
  }
  if(offset!=length)return 0;dw=mx-dx;dh=my-dy;return count?count:1;
}
