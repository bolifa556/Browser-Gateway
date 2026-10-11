#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/extensions/Xcomposite.h>
#include <X11/extensions/Xdamage.h>
#include <X11/extensions/XShm.h>
#include <X11/extensions/Xfixes.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <unistd.h>
#include <poll.h>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <deque>
#include <algorithm>
#include "qoi.c"
static int xerror=0;
static int handleXError(Display*,XErrorEvent*event){xerror=event->error_code;return 0;}
static Window findWindow(Display*d,Window root,const std::string&title){
  Atom name=XInternAtom(d,"_NET_WM_NAME",False),type;int format;unsigned long n,remaining;unsigned char*data=nullptr;
  if(XGetWindowProperty(d,root,name,0,1024,False,AnyPropertyType,&type,&format,&n,&remaining,&data)==Success&&data){
    bool match=std::string((char*)data,n).find(title)!=std::string::npos;XFree(data);if(match)return root;
  }
  Window ignored,parent,*children=nullptr;unsigned int count=0;
  if(!XQueryTree(d,root,&ignored,&parent,&children,&count))return 0;
  Window result=0;for(unsigned i=0;i<count&&!result;i++)result=findWindow(d,children[i],title);
  if(children)XFree(children);return result;
}
static void append16(std::vector<u8>&v,u32 x){v.push_back(x);v.push_back(x>>8);}
static void append32(std::vector<u8>&v,u32 x){v.push_back(x);v.push_back(x>>8);v.push_back(x>>16);v.push_back(x>>24);}
int main(int argc,char**argv){
  if(argc!=8){std::cerr<<"usage: capture TITLE W H X Y FPS WORKERS\n";return 2;}
  std::string title=argv[1];int w=std::stoi(argv[2]),h=std::stoi(argv[3]),cropX=std::stoi(argv[4]),cropY=std::stoi(argv[5]),fps=std::stoi(argv[6]);
  if(w<1||h<1||w>8192||h>4320||cropX<0||cropY<0||fps<1||fps>120)return 2;
  int rows=(h+63)/64,workers=std::max(1,std::min(rows,std::stoi(argv[7])));
  Display*d=XOpenDisplay(nullptr);if(!d){std::cerr<<"X display unavailable\n";return 3;}XSetErrorHandler(handleXError);
  Window window=0;
  if(title.rfind("xid:",0)==0)window=std::stoul(title.substr(4));
  for(int retry=0;retry<100&&!window;retry++){window=findWindow(d,DefaultRootWindow(d),title);if(!window)usleep(50000);}
  if(!window){std::cerr<<"Managed window not found\n";return 4;}
  XWindowAttributes attributes;XGetWindowAttributes(d,window,&attributes);
  XSelectInput(d,window,StructureNotifyMask);
  if(cropX+w>attributes.width||cropY+h>attributes.height){std::cerr<<"Invalid crop: window="<<attributes.width<<'x'<<attributes.height<<" region="<<cropX<<','<<cropY<<' '<<w<<'x'<<h<<'\n';return 5;}
  xerror=0;XCompositeRedirectWindow(d,window,CompositeRedirectAutomatic);XSync(d,False);
  Pixmap pixmap=XCompositeNameWindowPixmap(d,window);XSync(d,False);
  if(xerror){std::cerr<<"XComposite unavailable error="<<xerror<<'\n';return 6;}
  XShmSegmentInfo shared{};XImage*image=XShmCreateImage(d,attributes.visual,attributes.depth,ZPixmap,nullptr,&shared,w,h);
  if(!image||image->bits_per_pixel!=32){std::cerr<<"32-bit RGB XImage required\n";return 7;}
  shared.shmid=shmget(IPC_PRIVATE,image->bytes_per_line*h,IPC_CREAT|0600);if(shared.shmid<0)return 8;
  shared.shmaddr=(char*)shmat(shared.shmid,nullptr,0);shared.readOnly=False;image->data=shared.shmaddr;
  XShmAttach(d,&shared);XSync(d,False);shmctl(shared.shmid,IPC_RMID,nullptr);
  if(xerror){std::cerr<<"XShm unavailable\n";return 9;}
  int damageEvent,damageError;bool useDamage=XDamageQueryExtension(d,&damageEvent,&damageError);Damage damage=useDamage?XDamageCreate(d,window,XDamageReportNonEmpty):0;
  XserverRegion damagedRegion=useDamage?XFixesCreateRegion(d,nullptr,0):0;
  // Two exact, ordered frames may be in flight. Capture/encode the next frame
  // while the client draws this one, without building a stale-frame backlog.
  std::mutex mutex;std::condition_variable jobs,finished,acknowledged;int generation=0,completed=0;bool force=true,frameForce=true;
  std::deque<u32> inFlight;u32 resetEpoch=0;
  int updateX=0,updateY=0,updateW=w,updateH=h;
  std::vector<std::vector<u8>> outputs(workers);std::vector<std::thread> pool;std::vector<u32> encodeUs(workers);
  for(int index=0;index<workers;index++)pool.emplace_back([&,index]{
    int startRow=rows*index/workers,endRow=rows*(index+1)/workers,y=startRow*64,sh=std::min(h,endRow*64)-y;
    std::vector<u8> heap((size_t)w*sh*13+((w+127)/128)*((sh+63)/64)*40+128);
    native_heap=heap.data();configure(w,sh);int last=0;
    while(true){
      std::unique_lock lock(mutex);jobs.wait(lock,[&]{return generation!=last;});last=generation;bool full=frameForce;lock.unlock();
      auto at=std::chrono::steady_clock::now();u32*dest=(u32*)input_pointer();
      const int first=std::max(y,updateY),end=std::min(y+sh,updateY+updateH);
      for(int row=first;row<end;row++){
        const u32*src=(const u32*)(image->data+(row-updateY)*image->bytes_per_line);
        u32*target=dest+(row-y)*w+updateX;
        for(int col=0;col<updateW;col++){u32 p=src[col];target[col]=((p&255)<<16)|(p&0xff00)|((p>>16)&255)|0xff000000;}
      }
      u32 length=(full||first<end)?encode_frame(full,last):0;auto &out=outputs[index];out.assign((u8*)output_pointer(),(u8*)output_pointer()+length);
      if(length){for(size_t pos=32;pos<out.size();){u32 yy=out[pos+2]|(out[pos+3]<<8);le16(out.data()+pos+2,yy+y);u32 len=out[pos+8]|(out[pos+9]<<8)|(out[pos+10]<<16)|(out[pos+11]<<24);pos+=12+len;}}
      encodeUs[index]=std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now()-at).count();
      lock.lock();completed++;if(completed==workers)finished.notify_one();
    }
  });
  std::thread commands([&]{std::string command;while(std::getline(std::cin,command)){
    std::lock_guard lock(mutex);
    if(command=="R"){force=true;inFlight.clear();resetEpoch++;acknowledged.notify_one();}
    else if(command.rfind("A ",0)==0){
      try{const u32 sequence=std::stoul(command.substr(2));auto frame=std::find(inFlight.begin(),inFlight.end(),sequence);
        if(frame!=inFlight.end()){inFlight.erase(frame);acknowledged.notify_one();}
      }catch(...){}
    }
  }});commands.detach();
  std::cerr<<"capture ready RGB window="<<window<<" size="<<w<<'x'<<h<<" crop="<<cropX<<','<<cropY<<" workers="<<workers<<'\n';
  bool rebind=false;u32 sequence=0;auto next=std::chrono::steady_clock::now();auto period=std::chrono::microseconds(1000000/fps);
  while(true){
    std::unique_lock lock(mutex);acknowledged.wait(lock,[&]{return inFlight.size()<2;});bool dirty=force;lock.unlock();
    while(XPending(d)){
      XEvent event;XNextEvent(d,&event);if(useDamage&&event.type==damageEvent+XDamageNotify)dirty=true;
      if(event.type==MapNotify||event.type==ConfigureNotify){rebind=true;dirty=true;}
    }
    if(!dirty&&useDamage){pollfd events{ConnectionNumber(d),POLLIN,0};poll(&events,1,16);continue;}
    std::this_thread::sleep_until(next);next=std::chrono::steady_clock::now()+period;
    lock.lock();frameForce=force||rebind;force=false;const u32 frameEpoch=resetEpoch;lock.unlock();
    auto copiedAt=std::chrono::steady_clock::now();
    updateX=0;updateY=0;updateW=w;updateH=h;
    if(useDamage){
      XDamageSubtract(d,damage,None,damagedRegion);
      XRectangle bounds{};int count=0;XRectangle*rectangles=XFixesFetchRegionAndBounds(d,damagedRegion,&count,&bounds);if(rectangles)XFree(rectangles);
      if(!frameForce){
        if(!count)continue;
        updateX=std::max(0,int(bounds.x)-cropX);updateY=std::max(0,int(bounds.y)-cropY);
        const int right=std::min(w,int(bounds.x)+int(bounds.width)-cropX),bottom=std::min(h,int(bounds.y)+int(bounds.height)-cropY);
        updateW=right-updateX;updateH=bottom-updateY;if(updateW<=0||updateH<=0)continue;
      }
    }
    // The name tracks ordinary paints, but not replacement of the window's
    // backing store. StructureNotify catches remaps/resizes (including browser
    // fullscreen), so retain the name for ordinary scrolling instead of issuing
    // two extra X requests for every frame. A new backing store gets a full frame.
    if(rebind){XFreePixmap(d,pixmap);xerror=0;pixmap=XCompositeNameWindowPixmap(d,window);rebind=false;}
    // Reuse the allocated full-frame shared segment for a tightly packed dirty
    // rectangle. Worker input buffers retain all pixels outside this rectangle.
    image->width=updateW;image->height=updateH;image->bytes_per_line=updateW*4;
    if(!XShmGetImage(d,pixmap,image,cropX+updateX,cropY+updateY,AllPlanes)||xerror){std::cerr<<"Window capture failed error="<<xerror<<'\n';std::_Exit(10);}
    u32 copiedUs=std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now()-copiedAt).count();
    lock.lock();completed=0;generation++;jobs.notify_all();finished.wait(lock,[&]{return completed==workers;});lock.unlock();
    u32 tiles=0;size_t total=32;for(auto &out:outputs)if(!out.empty()){tiles+=out[12]|(out[13]<<8);total+=out.size()-32;}
    if(!tiles)continue;
    lock.lock();
    // A reset during encoding must not leak a delta from the previous epoch.
    if(frameEpoch!=resetEpoch){lock.unlock();continue;}
    inFlight.push_back(++sequence);lock.unlock();
    std::vector<u8> packet;packet.reserve(total);append32(packet,0x314f5147);append32(packet,sequence);append16(packet,w);append16(packet,h);append16(packet,tiles);append16(packet,frameForce);
    for(int i=0;i<8;i++)packet.push_back(0);append32(packet,copiedUs);append32(packet,*std::max_element(encodeUs.begin(),encodeUs.end()));
    for(auto &out:outputs)if(!out.empty())packet.insert(packet.end(),out.begin()+32,out.end());
    u32 length=packet.size();std::cout.write((char*)&length,4);std::cout.write((char*)packet.data(),packet.size());std::cout.flush();
    if(!std::cout.good())return 0;
  }
}
