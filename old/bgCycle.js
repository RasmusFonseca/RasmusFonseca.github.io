var image;
var imageCycle = [
  "bgCycle/Gramicidin.png",
  "bgCycle/SteinerTree.png",
  "bgCycle/void.png",
  "bgCycle/CT2.png",
  "bgCycle/Eiffel.png",
  "bgCycle/AC_CPH18.png",
];
var counter = 0;
function initCycle(){
  divs = document.getElementById("imgCycle");
  image = document.createElement("img");
  image.src = imageCycle[counter];
  image.style.opacity = 0;
  image.style.width = "400px";
  divs.appendChild(image);
  showImage();
}

function println(line){
  deb = document.getElementById("debug");
  deb.innerHTML += line+"<br>";
}

function showImage(){
  curAlpha = image.style.opacity;
  image.style.opacity = Math.min(parseFloat(curAlpha)+0.06, 1);

  if(image.style.opacity<1)
    setTimeout(showImage, 50);
  else{
    setTimeout(hideImage, 5000);
  }
}

function hideImage(){
  curAlpha = image.style.opacity;
  image.style.opacity = Math.max(parseFloat(curAlpha)-0.06, 0);

  if(image.style.opacity>0){
    setTimeout(hideImage, 50);
  } else{
    counter+=1;
    if(counter>=imageCycle.length) counter = 0;
    image.setAttribute("src",imageCycle[counter]);
    setTimeout(showImage, 1000);
  }

}
